import { UserError, errorMessage, type Env, type Interaction, type Message } from "./types";

const API = "https://discord.com/api/v10";
const encoder = new TextEncoder();
let keyCache: { hex: string; key: CryptoKey } | undefined;

function bytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

export async function verifySignature(
  publicKey: string, signature: string | null, timestamp: string | null, body: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  if (!/^[a-f\d]{64}$/i.test(publicKey) || !signature || !/^[a-f\d]{128}$/i.test(signature)
    || !timestamp || !/^\d{10,13}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    if (keyCache?.hex !== publicKey) {
      keyCache = { hex: publicKey, key: await crypto.subtle.importKey(
        "raw", bytes(publicKey), { name: "Ed25519" }, false, ["verify"],
      ) };
    }
    const prefix = encoder.encode(timestamp);
    const signed = new Uint8Array(prefix.length + body.length);
    signed.set(prefix);
    signed.set(body, prefix.length);
    return await crypto.subtle.verify("Ed25519", keyCache.key, bytes(signature), signed);
  } catch {
    return false;
  }
}

export class DiscordError extends Error {
  constructor(readonly status: number) {
    super(`Discord request failed (HTTP ${status}).`);
  }
}

export class Discord {
  constructor(private env: Pick<Env, "DISCORD_BOT_TOKEN" | "DISCORD_APPLICATION_ID">) {}

  private async request<T>(
    method: string, path: string, message?: Message, attachment?: Uint8Array<ArrayBuffer>, authenticated = true,
  ): Promise<T> {
    const headers = new Headers();
    if (authenticated) headers.set("Authorization", `Bot ${this.env.DISCORD_BOT_TOKEN}`);
    let body: BodyInit | undefined;
    if (message) {
      const payload = { allowed_mentions: { parse: [] }, ...message };
      if (attachment) {
        const form = new FormData();
        form.set("payload_json", JSON.stringify({
          ...payload, attachments: [{ id: 0, filename: "rating.png", description: "ArugoBot rating history" }],
        }));
        form.set("files[0]", new Blob([attachment], { type: "image/png" }), "rating.png");
        body = form;
      } else {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(payload);
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${API}${path}`, {
        method, headers, body, signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 429 && attempt === 0) {
        const limit = await response.json<{ retry_after?: number }>();
        if (limit.retry_after && limit.retry_after <= 2) {
          await new Promise((resolve) => setTimeout(resolve, Math.ceil(limit.retry_after! * 1000)));
          continue;
        }
      }
      if (!response.ok) throw new DiscordError(response.status);
      return response.status === 204 ? undefined as T : await response.json<T>();
    }
    throw new DiscordError(429);
  }

  send(channelId: string, message: Message): Promise<{ id: string }> {
    return this.request("POST", `/channels/${channelId}/messages`, message);
  }

  edit(channelId: string, messageId: string, message: Message): Promise<{ id: string }> {
    return this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, message);
  }

  response(interaction: Interaction, message: Message, png?: Uint8Array<ArrayBuffer>): Promise<{ id: string }> {
    return this.request("PATCH",
      `/webhooks/${this.env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`, message, png, false);
  }

  followup(interaction: Interaction, content: string): Promise<{ id: string }> {
    return this.request("POST", `/webhooks/${this.env.DISCORD_APPLICATION_ID}/${interaction.token}`,
      { content, flags: 64 }, undefined, false);
  }

  async error(interaction: Interaction, error: unknown): Promise<void> {
    const content = error instanceof UserError
      ? error.message
      : "Something went wrong. Please try again shortly.";
    if (!(error instanceof UserError)) console.error("Interaction failed:", errorMessage(error));
    try {
      if (interaction.type === 3) await this.followup(interaction, content);
      else await this.response(interaction, { content, embeds: [], components: [] });
    } catch (replyError) {
      console.error("Could not report interaction error:", errorMessage(replyError));
    }
  }
}

export function messageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
