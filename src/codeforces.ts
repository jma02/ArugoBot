import { sql } from "./database";
import { UserError, errorMessage, type Account, type Submission } from "./types";

const PAGE_SIZE = 200;
const MINUTE = 60_000;
type Transport = typeof fetch;

export class CodeforcesError extends UserError {
  constructor(message: string, readonly temporary = true, readonly allowCancellation = true) {
    super(message);
  }
}

export class Codeforces {
  constructor(
    private db: D1Database,
    private transport: Transport = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async request<T>(endpoint: string, parameters: Record<string, string | number>): Promise<T> {
    const now = Date.now();
    // Shared between commands and cron, and between Worker locations.
    const slot = await sql(this.db, `UPDATE api_budget
      SET next_at = MAX(next_at, backoff_until, ?) + 2100
      WHERE id = 1 AND MAX(next_at, backoff_until, ?) <= ?
      RETURNING next_at`, now, now, now + 8_000).first<{ next_at: number }>();
    if (!slot) throw new CodeforcesError("Codeforces requests are busy. Please try again in a moment.", true, false);
    const wait = slot.next_at - 2100 - Date.now();
    if (wait > 0) await this.sleep(wait);
    const query = new URLSearchParams(Object.entries(parameters).map(([key, value]) => [key, String(value)]));
    let response: Response;
    try {
      response = await this.transport.call(globalThis, `https://codeforces.com/api/${endpoint}?${query}`, {
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      const detail = error instanceof Error
        ? `${error.name}: ${error.message.replace(/https?:\/\/\S+/g, "[URL]").slice(0, 200)}`
        : "Unknown transport error";
      console.error("Codeforces transport failure:", detail);
      throw new CodeforcesError("Codeforces could not be reached. Please try again shortly.");
    }
    if (response.status === 429) {
      const retry = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 300_000) : MINUTE;
      await sql(this.db, "UPDATE api_budget SET backoff_until = MAX(backoff_until, ?) WHERE id = 1",
        Date.now() + delay).run();
      throw new CodeforcesError("Codeforces is limiting requests. ArugoBot will retry shortly.", true, false);
    }
    let data: { status: string; result?: T; comment?: string };
    try {
      data = await response.json<typeof data>();
    } catch {
      throw new CodeforcesError("Codeforces returned an unavailable response. Please try again later.");
    }
    if (!response.ok || data.status !== "OK" || data.result === undefined) {
      const invalidHandle = /(?:handle.*not found|handles:.*not found)/i.test(data.comment ?? "");
      throw new CodeforcesError(
        invalidHandle ? "That Codeforces handle was not found." : "Codeforces is unavailable. ArugoBot will retry shortly.",
        !invalidHandle,
      );
    }
    return data.result;
  }

  async canonicalHandle(handle: string): Promise<string> {
    if (!/^[A-Za-z0-9_.-]{1,24}$/.test(handle)) throw new UserError("Enter a valid Codeforces handle.");
    const users = await this.request<{ handle: string }[]>("user.info", { handles: handle });
    if (!users[0]) throw new UserError("That Codeforces handle was not found.");
    return users[0].handle;
  }

  submissions(handle: string, from: number, count = PAGE_SIZE): Promise<Submission[]> {
    return this.request("user.status", { handle, from, count });
  }

  contestSubmissions(handle: string, contestId: number, from = 1): Promise<Submission[]> {
    return this.request("contest.status", { handle, contestId, from, count: 100, asManager: "false" });
  }
}

export function submissionProblem(submission: Submission): string | null {
  const contest = submission.problem.contestId ?? submission.contestId;
  return contest ? `${contest}${submission.problem.index}` : null;
}

export async function requestSync(db: D1Database, handles: string[]): Promise<void> {
  const now = Date.now();
  await db.batch(handles.map((handle) => sql(db, `INSERT INTO cf_accounts(handle, next_sync) VALUES (?, ?)
    ON CONFLICT(handle) DO UPDATE SET next_sync = ?, cursor = 1, new_latest_id = 0, scanned = 0,
      stop_id = MIN(cf_accounts.latest_id, COALESCE(
        (SELECT MIN(submission_id) FROM pending_submissions WHERE handle = excluded.handle),
        cf_accounts.latest_id))
    WHERE cf_accounts.next_sync IS NULL
      AND (cf_accounts.synced_at IS NULL OR cf_accounts.synced_at < ?)`,
  handle, now, now, now - MINUTE)));
}

export async function syncAccount(db: D1Database, cf: Codeforces, handle: string): Promise<void> {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const account = await sql(db, `UPDATE cf_accounts SET lease_owner = ?, lease_until = ?
    WHERE handle = ? AND next_sync IS NOT NULL AND lease_until <= ? RETURNING *`,
  owner, now + 30_000, handle, now).first<Account>();
  if (!account) return;
  try {
    const submissions = await cf.submissions(account.handle, account.cursor);
    const accepted = [...new Set(submissions.filter((entry) => entry.verdict === "OK")
      .map(submissionProblem).filter((id): id is string => id !== null))];
    const pending = submissions.filter((entry) => !entry.verdict || entry.verdict === "TESTING").map((entry) => entry.id);
    const resolved = submissions.filter((entry) => entry.verdict && entry.verdict !== "TESTING").map((entry) => entry.id);
    const newLatest = Math.max(account.new_latest_id, submissions[0]?.id ?? 0);
    const complete = submissions.length < PAGE_SIZE
      || (account.stop_id > 0 && submissions.some((entry) => entry.id <= account.stop_id));
    await db.batch([
      sql(db, `INSERT OR IGNORE INTO solved(handle, problem_id) SELECT ?, value FROM json_each(?)`,
        account.handle, JSON.stringify(accepted)),
      sql(db, `DELETE FROM pending_submissions WHERE handle = ?
        AND submission_id IN (SELECT value FROM json_each(?))`, account.handle, JSON.stringify(resolved)),
      sql(db, `INSERT OR IGNORE INTO pending_submissions(handle, submission_id)
        SELECT ?, value FROM json_each(?)`, account.handle, JSON.stringify(pending)),
      sql(db, `UPDATE cf_accounts SET cursor = ?, new_latest_id = ?, latest_id = ?,
        next_sync = ?, synced_at = ?, scanned = scanned + ?, last_error = NULL,
        lease_owner = NULL, lease_until = 0 WHERE handle = ? AND lease_owner = ?`,
      complete ? 1 : account.cursor + PAGE_SIZE, newLatest, complete ? newLatest : account.latest_id,
      complete ? null : Date.now() + 2100, complete ? Date.now() : account.synced_at,
      submissions.length, account.handle, owner),
    ]);
  } catch (error) {
    await sql(db, `UPDATE cf_accounts SET next_sync = ?, last_error = ?, lease_owner = NULL, lease_until = 0
      WHERE handle = ? AND lease_owner = ?`,
    Date.now() + MINUTE, errorMessage(error), account.handle, owner).run();
  }
}

export async function ensureFreshAccounts(db: D1Database, cf: Codeforces, handles: string[]): Promise<void> {
  await requestSync(db, handles);
  const accounts = (await sql(db, `SELECT * FROM cf_accounts
    WHERE handle COLLATE NOCASE IN (SELECT value FROM json_each(?))`, JSON.stringify(handles)).all<Account>()).results;
  const pending = accounts.filter((entry) => entry.next_sync !== null);
  // One page can finish an ordinary incremental refresh without exceeding an
  // interaction's 30-second post-response lifetime. Cron handles full histories.
  if (pending[0]) await syncAccount(db, cf, pending[0].handle);
  const incomplete = await sql(db, `SELECT handle, scanned FROM cf_accounts
    WHERE handle COLLATE NOCASE IN (SELECT value FROM json_each(?)) AND next_sync IS NOT NULL LIMIT 1`,
  JSON.stringify(handles)).first<{ handle: string; scanned: number }>();
  if (incomplete) {
    throw new UserError(`Codeforces history for **${incomplete.handle}** is updating (${incomplete.scanned} submissions checked). `
      + "Please try again in a minute. Large histories can take a few minutes.");
  }
}

export async function solvedProblems(db: D1Database, handles: string[]): Promise<Set<string>> {
  const rows = (await sql(db, `SELECT DISTINCT problem_id FROM solved
    WHERE handle COLLATE NOCASE IN (SELECT value FROM json_each(?))`, JSON.stringify(handles))
    .all<{ problem_id: string }>()).results;
  return new Set(rows.map((row) => row.problem_id));
}
