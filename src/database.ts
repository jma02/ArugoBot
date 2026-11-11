import type { Challenge, Participant, UserRow } from "./types";

export function sql(db: D1Database, text: string, ...values: unknown[]): D1PreparedStatement {
  return db.prepare(text).bind(...values);
}

export async function user(db: D1Database, guildId: string, userId: string): Promise<UserRow | null> {
  return sql(db, "SELECT * FROM users WHERE guild_id = ? AND user_id = ?", guildId, userId).first<UserRow>();
}

export async function challenge(db: D1Database, id: string): Promise<Challenge | null> {
  return sql(db, "SELECT * FROM challenges WHERE id = ?", id).first<Challenge>();
}

export async function participants(db: D1Database, id: string): Promise<Participant[]> {
  return (await sql(db, "SELECT * FROM participants WHERE challenge_id = ? ORDER BY user_id", id)
    .all<Participant>()).results;
}

export async function cooldown(db: D1Database, key: string, milliseconds: number): Promise<boolean> {
  const now = Date.now();
  const result = await sql(db, `INSERT INTO cooldowns(key, until_at) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET until_at = excluded.until_at
    WHERE cooldowns.until_at <= ?`, key, now + milliseconds, now).run();
  return result.meta.changes === 1;
}

export async function acquireLease(db: D1Database, name: string, ttl = 55_000): Promise<string | null> {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const result = await sql(db, `INSERT INTO leases(name, owner, until_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, until_at = excluded.until_at
    WHERE leases.until_at <= ?`, name, owner, now + ttl, now).run();
  return result.meta.changes === 1 ? owner : null;
}

export async function releaseLease(db: D1Database, name: string, owner: string): Promise<void> {
  await sql(db, "DELETE FROM leases WHERE name = ? AND owner = ?", name, owner).run();
}
