import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          DISCORD_APPLICATION_ID: "123456789012345678",
          DISCORD_PUBLIC_KEY: "0".repeat(64),
          DISCORD_BOT_TOKEN: "test-token-not-a-credential",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
