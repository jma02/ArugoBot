import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../src/command-schema.ts";

export async function registerCommands(token: string, applicationId: string, guildId?: string): Promise<void> {
  if (!token || !/^\d{1,20}$/.test(applicationId) || (guildId && !/^\d{1,20}$/.test(guildId))) {
    throw new Error("Set DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID. DISCORD_GUILD_ID is optional.");
  }
  const target = guildId
    ? `/applications/${applicationId}/guilds/${guildId}/commands`
    : `/applications/${applicationId}/commands`;
  const response = await fetch(`https://discord.com/api/v10${target}`, {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(COMMANDS),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Discord command registration failed (HTTP ${response.status}). Check the application ID and bot token.`);
  console.log(`Registered ${COMMANDS.length} ArugoBot commands ${guildId ? "in the test server" : "globally"}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await registerCommands(
    process.env.DISCORD_BOT_TOKEN ?? "", process.env.DISCORD_APPLICATION_ID ?? "", process.env.DISCORD_GUILD_ID,
  );
}
