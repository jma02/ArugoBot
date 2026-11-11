import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import worker from "../src/worker";
import type { Env, Interaction } from "../src/types";

let keys: CryptoKeyPair;
let publicKey: string;
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");

beforeAll(async () => {
  keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  publicKey = hex(await crypto.subtle.exportKey("raw", keys.publicKey));
});

function testEnv(): Env { return { ...env, DISCORD_PUBLIC_KEY: publicKey }; }

async function signed(body: unknown, timestamp = String(Math.floor(Date.now() / 1000))): Promise<Request> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const signature = await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + text));
  return new Request("https://arugobot.test/interactions", {
    method: "POST", body: text,
    headers: { "X-Signature-Ed25519": hex(signature), "X-Signature-Timestamp": timestamp },
  });
}

const ping: Interaction = {
  id: "10001", application_id: "123456789012345678", type: 2, token: "test-interaction-token",
  guild_id: "1", channel_id: "2", member: { user: { id: "3", username: "tester" } },
  data: { name: "ping" },
};

it("serves ArugoBot's health endpoint", async () => {
  const response = await worker.fetch(new Request("https://arugobot.test/healthz"), testEnv(), createExecutionContext());
  expect(await response.json()).toEqual({ name: "ArugoBot", status: "ok", commands: "/help" });
});

it("answers Discord's signed endpoint verification ping", async () => {
  const response = await worker.fetch(await signed({ type: 1 }), testEnv(), createExecutionContext());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ type: 1 });
});

it("rejects unsigned and tampered requests", async () => {
  const request = await signed(ping);
  const tampered = new Request(request.url, { method: "POST", headers: request.headers, body: '{"type":1}' });
  expect((await worker.fetch(tampered, testEnv(), createExecutionContext())).status).toBe(401);
  expect((await worker.fetch(new Request(request.url, { method: "POST", body: "{}" }), testEnv(), createExecutionContext())).status).toBe(401);
});

it("rejects replayed signatures and signatures from the future", async () => {
  for (const seconds of [-600, 600]) {
    const request = await signed(ping, String(Math.floor(Date.now() / 1000) + seconds));
    expect((await worker.fetch(request, testEnv(), createExecutionContext())).status).toBe(401);
  }
});

it("validates signed payloads and application identity", async () => {
  expect((await worker.fetch(await signed("{bad json"), testEnv(), createExecutionContext())).status).toBe(400);
  expect((await worker.fetch(await signed({ ...ping, application_id: "another-app" }), testEnv(), createExecutionContext())).status).toBe(400);
});

it("rejects oversized bodies even without a Content-Length header", async () => {
  const request = new Request("https://arugobot.test/interactions", { method: "POST", body: "a".repeat(128 * 1024 + 1) });
  expect((await worker.fetch(request, testEnv(), createExecutionContext())).status).toBe(413);
});

it("keeps guild-only commands out of DMs", async () => {
  const response = await worker.fetch(await signed({ ...ping, guild_id: undefined }), testEnv(), createExecutionContext());
  expect(await response.json()).toMatchObject({ type: 4, data: { flags: 64 } });
});

it("acknowledges commands and handles duplicate deliveries only once", async () => {
  const transport = vi.mocked(fetch).mockImplementation(async () => Response.json({ id: "reply-id" }));
  const first = createExecutionContext();
  const second = createExecutionContext();
  const response = await worker.fetch(await signed(ping), testEnv(), first);
  expect(await response.json()).toEqual({ type: 5, data: {} });
  await worker.fetch(await signed(ping), testEnv(), second);
  await Promise.all([waitOnExecutionContext(first), waitOnExecutionContext(second)]);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(String(transport.mock.calls[0]![0])).toContain("/messages/@original");
  expect(JSON.parse(String(transport.mock.calls[0]![1]?.body))).toMatchObject({ content: "Pong!" });
});

it("defers a slow registration privately before Codeforces finishes", async () => {
  let finishCF!: () => void;
  const pending = new Promise<void>((resolve) => { finishCF = resolve; });
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (String(url).includes("codeforces.com")) {
      await pending;
      return Response.json({ status: "OK", result: [{ handle: "tourist" }] });
    }
    return Response.json({ id: "verification-message" });
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(await signed({
    ...ping, data: { name: "register", options: [{ name: "handle", value: "tourist" }] },
  }), testEnv(), ctx);
  expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
  finishCF();
  await waitOnExecutionContext(ctx);
  const registration = await env.DB.prepare("SELECT handle, status FROM registrations").first();
  expect(registration).toEqual({ handle: "tourist", status: "pending" });
});
