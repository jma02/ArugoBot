import { cancelWaiting, checkParticipant, publishChallenge } from "./challenges";
import { Codeforces, syncAccount } from "./codeforces";
import { acquireLease, releaseLease, sql } from "./database";
import { Discord } from "./discord";
import { checkRegistration, publishRegistration } from "./registration";
import { errorMessage, type BackgroundJob, type Env, type QueuedJob } from "./types";

export function jobKey(job: BackgroundJob): string {
  return `queued:${job.kind}:${job.id.toLowerCase()}${job.userId ? `:${job.userId}` : ""}`;
}

export async function enqueueJobs(env: Env, jobs: BackgroundJob[], delaySeconds = 0): Promise<void> {
  if (!jobs.length) return;
  const now = Date.now();
  const queued = jobs.map((job): QueuedJob => ({ ...job, queueOwner: crypto.randomUUID() }));
  const claims = await env.DB.batch(queued.map((job) => sql(env.DB, `
    INSERT INTO leases(name, owner, until_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, until_at = excluded.until_at
    WHERE leases.until_at <= ?`, jobKey(job), job.queueOwner, now + 120_000, now)));
  const claimed = queued.filter((_job, index) => claims[index]!.meta.changes === 1);
  if (!claimed.length) return;
  try {
    await env.JOBS.sendBatch(claimed.map((body) => ({ body })), { delaySeconds });
  } catch (error) {
    await env.DB.batch(claimed.map((job) =>
      sql(env.DB, "DELETE FROM leases WHERE name = ? AND owner = ?", jobKey(job), job.queueOwner)));
    throw error;
  }
}

// Each background check gets its own small invocation instead of sharing one
// Free Worker's CPU/query budget between every active participant.
export async function scheduledTick(env: Env): Promise<void> {
  const owner = await acquireLease(env.DB, "cron");
  if (!owner) return;
  try {
    const now = Date.now();
    const jobs = (await sql(env.DB, `WITH jobs AS (
      SELECT CASE WHEN status = 'pending' AND next_poll <= ?1 AND lease_until <= ?1
          THEN 'registration' ELSE 'publish_registration' END AS kind,
        id, NULL AS userId, CASE WHEN status = 'pending' THEN next_poll ELSE created_at END AS due
        FROM registrations WHERE (status = 'pending' AND next_poll <= ?1 AND lease_until <= ?1)
          OR (dirty = 1 AND message_id IS NOT NULL AND publish_after <= ?1)
      UNION ALL
      SELECT 'participant', p.challenge_id, p.user_id, p.next_poll FROM participants p
        JOIN challenges c ON c.id = p.challenge_id
        WHERE c.status = 'active' AND p.outcome = 'pending' AND p.next_poll <= ?1 AND p.lease_until <= ?1
      UNION ALL
      SELECT 'account', handle, NULL, next_sync FROM cf_accounts
        WHERE next_sync IS NOT NULL AND next_sync <= ?1 AND lease_until <= ?1
      UNION ALL
      SELECT CASE WHEN status = 'waiting' AND confirm_until <= ?1 THEN 'expire' ELSE 'publish_challenge' END,
        id, NULL, CASE WHEN status = 'waiting' THEN confirm_until ELSE created_at END FROM challenges
        WHERE (status = 'waiting' AND confirm_until <= ?1)
          OR (dirty = 1 AND message_id IS NOT NULL AND publish_until <= ?1)
    )
    SELECT jobs.kind, jobs.id, jobs.userId FROM jobs LEFT JOIN leases
      ON leases.name = 'queued:' || jobs.kind || ':' || LOWER(jobs.id)
        || CASE WHEN jobs.userId IS NULL THEN '' ELSE ':' || jobs.userId END
    WHERE leases.until_at IS NULL OR leases.until_at <= ?1
    ORDER BY jobs.due LIMIT 20`, now)
      .all<BackgroundJob>()).results;
    await enqueueJobs(env, jobs);
    if (new Date(now).getUTCMinutes() === 0) {
      await env.DB.batch([
        sql(env.DB, `DELETE FROM interactions WHERE id IN
          (SELECT id FROM interactions WHERE received_at < ? LIMIT 1000)`, now - 86_400_000),
        sql(env.DB, "DELETE FROM cooldowns WHERE until_at < ?", now - 86_400_000),
      ]);
    }
  } finally {
    await releaseLease(env.DB, "cron", owner);
  }
}

async function runJob(env: Env, job: BackgroundJob): Promise<BackgroundJob | null> {
  const cf = new Codeforces(env.DB);
  const discord = new Discord(env);
  switch (job.kind) {
    case "registration":
      await checkRegistration(env.DB, cf, job.id);
      await publishRegistration(env.DB, discord, job.id);
      break;
    case "participant": {
      if (!job.userId) return null;
      await checkParticipant(env.DB, cf, job.id, job.userId);
      await publishChallenge(env.DB, discord, job.id);
      const continuation = await sql(env.DB, `SELECT 1 FROM participants WHERE challenge_id = ? AND user_id = ?
        AND outcome = 'pending' AND next_poll <= ?`, job.id, job.userId, Date.now() + 5_000).first();
      return continuation ? { kind: "participant", id: job.id, userId: job.userId } : null;
    }
    case "account": {
      await syncAccount(env.DB, cf, job.id);
      const continuation = await sql(env.DB, `SELECT 1 FROM cf_accounts
        WHERE handle = ? AND next_sync IS NOT NULL AND next_sync <= ?`, job.id, Date.now() + 5_000).first();
      return continuation ? { kind: "account", id: job.id } : null;
    }
    case "expire":
      await cancelWaiting(env.DB, job.id);
      await publishChallenge(env.DB, discord, job.id);
      break;
    case "publish_challenge":
      await publishChallenge(env.DB, discord, job.id);
      break;
    case "publish_registration":
      await publishRegistration(env.DB, discord, job.id);
      break;
  }
  return null;
}

export async function consumeJobs(batch: MessageBatch<QueuedJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    if (!job || typeof job.id !== "string" || typeof job.queueOwner !== "string"
      || !["registration", "participant", "account", "expire", "publish_challenge", "publish_registration"].includes(job.kind)) {
      console.error("Ignoring an invalid ArugoBot job.");
      message.ack();
      continue;
    }
    try {
      const current = await sql(env.DB, "SELECT 1 FROM leases WHERE name = ? AND owner = ?",
        jobKey(job), job.queueOwner).first();
      if (current) {
        const continuation = await runJob(env, job);
        await releaseLease(env.DB, jobKey(job), job.queueOwner);
        if (continuation) await enqueueJobs(env, [continuation], 3);
      }
      message.ack();
    } catch (error) {
      console.error("Background check will retry:", job.kind, errorMessage(error));
      message.retry({ delaySeconds: 60 });
    }
  }
}
