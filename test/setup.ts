import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, vi } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected external request in test."); }));
  await env.DB.batch([
    "DELETE FROM rating_events",
    "DELETE FROM challenge_locks",
    "DELETE FROM participants",
    "DELETE FROM challenges",
    "DELETE FROM registrations",
    "DELETE FROM users",
    "DELETE FROM solved",
    "DELETE FROM pending_submissions",
    "DELETE FROM cf_accounts",
    "DELETE FROM cooldowns",
    "DELETE FROM interactions",
    "DELETE FROM leases",
    "UPDATE api_budget SET next_at = 0, backoff_until = 0",
  ].map((statement) => env.DB.prepare(statement)));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
