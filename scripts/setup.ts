import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath, URL } from "node:url";
import { registerCommands } from "./register-commands.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

function run(args: string[], options: { capture?: boolean; input?: string } = {}): string {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: "utf8",
    input: options.input,
    stdio: [options.input === undefined ? "inherit" : "pipe", options.capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler ${args[0]} failed. Fix the reported issue and rerun npm run setup.`);
  return result.stdout ?? "";
}

console.log("ArugoBot setup: Cloudflare Workers + D1 + Queues. This creates the app, storage, and scheduled checks.");
console.log("Stay on Cloudflare's Free plan; no paid services are required by this configuration.");
run(["login"]);

const config = JSON.parse(await readFile(configPath, "utf8"));
const binding = config.d1_databases.find((entry: { binding: string }) => entry.binding === "DB");
if (!binding) throw new Error("The DB binding is missing from wrangler.jsonc.");

let muted = false;
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  },
});
const prompt = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY), historySize: 0 });
try {
  const databases = JSON.parse(run(["d1", "list", "--json"], { capture: true })) as { uuid: string; name: string }[];
  if (!databases.some((entry) => entry.uuid === binding.database_id)) {
    const existing = databases.find((entry) => entry.name === binding.database_name);
    if (existing) {
      const answer = await prompt.question(`A D1 database named ${binding.database_name} already exists. Reuse it? [y/N] `);
      if (answer.trim().toLowerCase() !== "y") throw new Error("Setup stopped. Choose another database_name in wrangler.jsonc before continuing.");
      binding.database_id = existing.uuid;
    } else {
      run(["d1", "create", binding.database_name, "--update-config=false"]);
      const refreshed = JSON.parse(run(["d1", "list", "--json"], { capture: true })) as { uuid: string; name: string }[];
      binding.database_id = refreshed.find((entry) => entry.name === binding.database_name)?.uuid;
      if (!binding.database_id) throw new Error("Could not find the new database. Check wrangler d1 list.");
    }
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  }

  const applicationId = (await prompt.question("Discord application ID: ")).trim();
  const publicKey = (await prompt.question("Discord application public key: ")).trim();
  if (!/^\d{1,20}$/.test(applicationId) || !/^[a-f\d]{64}$/i.test(publicKey)) {
    throw new Error("The application ID or public key is invalid. Copy them from Discord's General Information page.");
  }
  process.stdout.write("Discord BOT token (hidden): ");
  muted = true;
  let token: string;
  try { token = (await prompt.question("")).trim(); }
  finally { muted = false; process.stdout.write("\n"); }
  if (!token) throw new Error("No bot token entered.");
  prompt.close();

  const queueName = config.queues.producers.find((entry: { binding: string }) => entry.binding === "JOBS")?.queue;
  if (!queueName) throw new Error("The JOBS queue binding is missing from wrangler.jsonc.");
  const queueInfo = spawnSync(process.execPath, [wrangler, "queues", "info", queueName], {
    cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"],
  });
  if (queueInfo.error) throw queueInfo.error;
  if (queueInfo.status !== 0) {
    if (`${queueInfo.stdout}\n${queueInfo.stderr}`.includes(`Queue "${queueName}" does not exist`)) {
      run(["queues", "create", queueName]);
    } else {
      throw new Error(`Could not inspect the queue. Run npx wrangler queues info ${queueName} to see the error.`);
    }
  }
  run(["d1", "migrations", "apply", "DB", "--remote"]);
  // Keep the terminal attached: first-time deployments may ask the user to
  // register a workers.dev subdomain.
  run(["deploy"]);
  // Values travel over stdin, never in command arguments or repository files.
  run(["secret", "put", "DISCORD_APPLICATION_ID"], { input: applicationId + "\n" });
  run(["secret", "put", "DISCORD_PUBLIC_KEY"], { input: publicKey + "\n" });
  run(["secret", "put", "DISCORD_BOT_TOKEN"], { input: token + "\n" });
  await registerCommands(token, applicationId);
  token = "";

  console.log("\nFinish in the Discord Developer Portal → General Information:");
  console.log("Set Interactions Endpoint URL to the Worker URL printed above, with /interactions appended.");
  console.log("Then invite ArugoBot using this link:");
  console.log(`https://discord.com/oauth2/authorize?client_id=${applicationId}&permissions=52224&integration_type=0&scope=bot%20applications.commands`);
  console.log("Try /ping and /help. Message Content Intent is not required.");
} finally {
  prompt.close();
}
