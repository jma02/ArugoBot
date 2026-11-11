import { Catalog } from "./catalog";
import { Codeforces, submissionProblem } from "./codeforces";
import { sql, user } from "./database";
import { Discord, DiscordError } from "./discord";
import {
  UserError, errorMessage, escapeMarkdown, problemParts, problemUrl,
  type Env, type Message, type Registration,
} from "./types";

const MINUTE = 60_000;

export async function createRegistration(
  env: Env, discord: Discord, cf: Codeforces,
  guildId: string, channelId: string, userId: string, input: string,
): Promise<Registration> {
  if (await user(env.DB, guildId, userId)) throw new UserError("You already have a linked handle. Use /unlink to remove it first.");
  const existing = await sql(env.DB, `SELECT * FROM registrations
    WHERE guild_id = ? AND user_id = ? AND status = 'pending'`, guildId, userId).first<Registration>();
  if (existing) return existing;
  const handle = await cf.canonicalHandle(input);
  if (await sql(env.DB, "SELECT 1 FROM users WHERE guild_id = ? AND handle = ?", guildId, handle).first()) {
    throw new UserError("That Codeforces handle is already linked in this server.");
  }
  const problem = await new Catalog(env.ASSETS).verificationProblem();
  const id = crypto.randomUUID();
  const now = Date.now();
  await sql(env.DB, `INSERT INTO registrations
    (id, guild_id, user_id, handle, channel_id, problem_id, created_at, submit_until, next_poll)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  id, guildId, userId, handle, channelId, problem.id, now, now + MINUTE, now + MINUTE).run();
  const registration = (await sql(env.DB, "SELECT * FROM registrations WHERE id = ?", id).first<Registration>())!;
  try {
    const message = await discord.send(channelId, {
      ...registrationMessage(registration), nonce: `r${id.replaceAll("-", "").slice(0, 24)}`, enforce_nonce: true,
    });
    await sql(env.DB, "UPDATE registrations SET message_id = ? WHERE id = ?", message.id, id).run();
    registration.message_id = message.id;
    return registration;
  } catch (error) {
    await sql(env.DB, `UPDATE registrations SET status = 'failed', detail = 'Could not post verification.' WHERE id = ?`, id).run();
    throw error;
  }
}

export function registrationMessage(registration: Registration): Message {
  if (registration.status !== "pending") {
    return {
      embeds: [{
        title: registration.status === "verified" ? "Handle verified" : "Verification ended",
        description: `<@${registration.user_id}> — ${registration.detail ?? "Please try /register again."}`,
        color: registration.status === "verified" ? 0x22c55e : 0x64748b,
      }],
      components: [],
    };
  }
  return {
    embeds: [{
      title: "Verify your Codeforces handle",
      description: `<@${registration.user_id}>, submit a **compilation error** as **${escapeMarkdown(registration.handle)}** `
        + `to [${registration.problem_id}](${problemUrl(registration.problem_id)}) `
        + `before <t:${Math.floor(registration.submit_until / 1000)}:R>.\n`
        + "ArugoBot will check automatically, or you can press the button after submitting.",
      color: 0x3b82f6,
    }],
    components: [{
      type: 1, components: [{
        type: 2, style: 1, label: "Check submission", custom_id: `verify:${registration.id}`,
      }],
    }],
  };
}

export async function completeRegistration(db: D1Database, registration: Registration, owner: string): Promise<void> {
  // The status change and unique user/handle insertion are one transaction.
  await db.batch([
    sql(db, `UPDATE registrations SET status = 'verified', detail = ?, dirty = 1
      WHERE id = ? AND status = 'pending' AND lease_owner = ?`,
    `Linked **${escapeMarkdown(registration.handle)}**. Your starting rating is **1500**.`,
    registration.id, owner),
    sql(db, `INSERT INTO users(guild_id, user_id, handle, rating, registration_id, created_at)
      SELECT guild_id, user_id, handle, 1500, id, ? FROM registrations
      WHERE id = ? AND status = 'verified' AND lease_owner = ?`, Date.now(), registration.id, owner),
    sql(db, `INSERT OR IGNORE INTO cf_accounts(handle, next_sync)
      SELECT handle, ? FROM registrations WHERE id = ? AND status = 'verified' AND lease_owner = ?`,
    Date.now(), registration.id, owner),
    sql(db, "UPDATE registrations SET lease_owner = NULL, lease_until = 0 WHERE id = ? AND lease_owner = ?",
      registration.id, owner),
  ]);
}

export async function checkRegistration(db: D1Database, cf: Codeforces, id: string): Promise<void> {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const registration = await sql(db, `UPDATE registrations SET lease_owner = ?, lease_until = ?
    WHERE id = ? AND status = 'pending' AND lease_until <= ? RETURNING *`,
  owner, now + 30_000, id, now).first<Registration>();
  if (!registration) return;
  try {
    const submissions = await cf.contestSubmissions(registration.handle, problemParts(registration.problem_id).contestId);
    const eligible = submissions.filter((submission) =>
      submissionProblem(submission) === registration.problem_id
      && submission.creationTimeSeconds * 1000 >= registration.created_at
      && submission.creationTimeSeconds * 1000 <= registration.submit_until);
    if (eligible.some((submission) => submission.verdict === "COMPILATION_ERROR")) {
      try {
        await completeRegistration(db, registration, owner);
      } catch (error) {
        if (!/UNIQUE constraint failed/i.test(errorMessage(error))) throw error;
        await sql(db, `UPDATE registrations SET status = 'failed', dirty = 1,
          detail = 'This user or handle was already linked. Use /register to check your account.'
          WHERE id = ? AND status = 'pending' AND lease_owner = ?`, id, owner).run();
      }
    } else if (now >= registration.submit_until
      && (!eligible.some((entry) => !entry.verdict || entry.verdict === "TESTING")
        || now >= registration.submit_until + 5 * MINUTE)) {
      await sql(db, `UPDATE registrations SET status = 'expired', dirty = 1,
        detail = 'No qualifying compilation error was found. Use /register to try again.'
        WHERE id = ? AND status = 'pending' AND lease_owner = ?`, id, owner).run();
    }
  } catch (error) {
    if (Date.now() >= registration.submit_until + 5 * MINUTE) {
      await sql(db, `UPDATE registrations SET status = 'expired', dirty = 1,
        detail = 'Codeforces could not be checked in time. Use /register to try again.'
        WHERE id = ? AND status = 'pending' AND lease_owner = ?`, id, owner).run();
    } else {
      await sql(db, "UPDATE registrations SET detail = ? WHERE id = ? AND lease_owner = ?",
        errorMessage(error), id, owner).run();
    }
  } finally {
    await sql(db, `UPDATE registrations SET next_poll = ?, lease_owner = NULL, lease_until = 0
      WHERE id = ? AND lease_owner = ?`, Date.now() + MINUTE, id, owner).run();
  }
}

export async function publishRegistration(db: D1Database, discord: Discord, id: string): Promise<void> {
  const registration = await sql(db, "SELECT * FROM registrations WHERE id = ? AND dirty = 1 AND publish_after <= ?",
    id, Date.now()).first<Registration>();
  if (!registration?.message_id) return;
  try {
    await discord.edit(registration.channel_id, registration.message_id, registrationMessage(registration));
    await sql(db, "UPDATE registrations SET dirty = 0 WHERE id = ? AND status = ?", id, registration.status).run();
  } catch (error) {
    if (error instanceof DiscordError && error.status === 404) {
      await sql(db, "UPDATE registrations SET dirty = 0 WHERE id = ?", id).run();
    } else {
      await sql(db, "UPDATE registrations SET publish_after = ? WHERE id = ?",
        Date.now() + (error instanceof DiscordError && error.status === 403 ? 15 * MINUTE : MINUTE), id).run();
      console.error("Verification message update delayed:", errorMessage(error));
    }
  }
}
