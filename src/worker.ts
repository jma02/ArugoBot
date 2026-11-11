import { handleInteraction } from "./commands";
import { verifySignature } from "./discord";
import { consumeJobs, scheduledTick } from "./scheduler";
import type { Env, Interaction, QueuedJob } from "./types";

async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 128 * 1024) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && (path === "/" || path === "/healthz")) {
      return Response.json({ name: "ArugoBot", status: "ok", commands: "/help" });
    }
    if (path !== "/interactions") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (!/^[a-f\d]{64}$/i.test(env.DISCORD_PUBLIC_KEY ?? "")) {
      return new Response("ArugoBot is not configured.", { status: 503 });
    }
    const body = await readBody(request);
    if (!body) return new Response("Payload too large", { status: 413 });
    if (!await verifySignature(env.DISCORD_PUBLIC_KEY, request.headers.get("X-Signature-Ed25519"),
      request.headers.get("X-Signature-Timestamp"), body)) {
      return new Response("Invalid signature", { status: 401 });
    }
    let interaction: Interaction;
    try { interaction = JSON.parse(new TextDecoder().decode(body)) as Interaction; }
    catch { return new Response("Invalid JSON", { status: 400 }); }
    if (!interaction || typeof interaction !== "object") return new Response("Invalid interaction", { status: 400 });
    if (interaction.type === 1) return Response.json({ type: 1 });
    if (![2, 3].includes(interaction.type) || interaction.application_id !== env.DISCORD_APPLICATION_ID
      || typeof interaction.id !== "string" || typeof interaction.token !== "string"
      || !interaction.data) return new Response("Invalid interaction", { status: 400 });
    if (!interaction.guild_id || !interaction.channel_id || !interaction.member?.user?.id) {
      return Response.json({ type: 4, data: { content: "Use ArugoBot in a server channel.", flags: 64 } });
    }
    if (!env.DISCORD_BOT_TOKEN) return new Response("ArugoBot is not configured.", { status: 503 });
    // Acknowledge immediately; Codeforces I/O must not consume Discord's
    // three-second response window. Durable work continues in D1 + cron.
    ctx.waitUntil(handleInteraction(env, interaction));
    if (interaction.type === 3) return Response.json({ type: 6 });
    const privateReply = ["register", "unlink", "challenge"].includes(interaction.data.name ?? "");
    return Response.json({ type: 5, data: privateReply ? { flags: 64 } : {} });
  },

  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(scheduledTick(env));
  },

  async queue(batch: MessageBatch<QueuedJob>, env: Env): Promise<void> {
    await consumeJobs(batch, env);
  },
} satisfies ExportedHandler<Env, QueuedJob>;
