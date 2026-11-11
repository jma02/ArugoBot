import { Codeforces, CodeforcesError, submissionProblem } from "./codeforces";
import { challenge, participants, sql } from "./database";
import { Discord, DiscordError } from "./discord";
import { DURATIONS, ratingChanges } from "./rating";
import {
  UserError, errorMessage, escapeMarkdown, problemParts, problemUrl,
  type Challenge, type Message, type Outcome, type Participant, type Problem, type UserRow,
} from "./types";

const MINUTE = 60_000;

export async function createChallenge(
  db: D1Database, discord: Discord, guildId: string, channelId: string, creatorId: string,
  problem: Problem, minutes: number, users: UserRow[],
): Promise<Challenge> {
  if (!(DURATIONS as readonly number[]).includes(minutes)) throw new UserError("Choose 40, 60, 80, 100, or 120 minutes.");
  if (!users.length || users.length > 5 || new Set(users.map((entry) => entry.user_id)).size !== users.length) {
    throw new UserError("A challenge needs one to five different participants.");
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    const result = await db.batch([
      sql(db, `INSERT INTO challenges(id, guild_id, creator_id, channel_id, problem_id,
        problem_name, problem_rating, minutes, status, confirm_until, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
      id, guildId, creatorId, channelId, problem.id, problem.name, problem.rating, minutes, now + 30_000, now),
      ...users.map((entry) => sql(db, `INSERT INTO participants(challenge_id, user_id, handle, rating_start)
        SELECT ?, user_id, handle, rating FROM users WHERE guild_id = ? AND user_id = ? AND registration_id = ?`,
      id, guildId, entry.user_id, entry.registration_id)),
      ...users.map((entry) => sql(db, `INSERT INTO challenge_locks(guild_id, user_id, challenge_id) VALUES (?, ?, ?)`,
        guildId, entry.user_id, id)),
    ]);
    if (result.slice(1, 1 + users.length).some((entry) => entry.meta.changes !== 1)) {
      await sql(db, "DELETE FROM challenges WHERE id = ?", id).run();
      throw new UserError("A participant's account changed. Please start the challenge again.");
    }
  } catch (error) {
    if (/UNIQUE constraint failed: challenge_locks/i.test(errorMessage(error))) {
      throw new UserError("Someone is already in a challenge in this server. Finish or cancel that challenge first.");
    }
    throw error;
  }
  const created = (await challenge(db, id))!;
  try {
    const message = await discord.send(channelId, {
      ...challengeMessage(created, await participants(db, id)),
      nonce: `c${id.replaceAll("-", "").slice(0, 24)}`, enforce_nonce: true,
    });
    // Give everyone the full confirmation window after the message is posted.
    await sql(db, "UPDATE challenges SET message_id = ?, confirm_until = ?, dirty = 1 WHERE id = ?",
      message.id, Date.now() + 30_000, id).run();
    created.message_id = message.id;
    return created;
  } catch (error) {
    await cancelWaiting(db, id);
    throw error;
  }
}

export function challengeMessage(value: Challenge, players: Participant[]): Message {
  const waiting = value.status === "waiting";
  const completed = value.status === "complete" || value.status === "cancelled";
  const labels: Record<Outcome, string> = {
    pending: waiting ? "not ready" : "working",
    solved: "solved",
    failed: "not solved",
    gave_up: "gave up",
    void: "no rating change",
  };
  const lines = players.map((player) => {
    const [loss, gain] = ratingChanges(player.rating_start, value.problem_rating, value.minutes);
    if (waiting) return `<@${player.user_id}> — ${player.rating_start} (${loss} / +${gain}) — ${player.ready ? "ready ✓" : "not ready"}`;
    if (player.outcome === "pending") return `<@${player.user_id}> — ${player.rating_start} — working`;
    const delta = player.outcome === "solved" ? gain : player.outcome === "void" ? 0 : loss;
    return `<@${player.user_id}> — ${player.rating_start} → **${player.rating_start + delta}** `
      + `(${delta >= 0 ? "+" : ""}${delta}) — ${labels[player.outcome]}`;
  });
  let description: string;
  if (waiting) description = `Everyone must confirm before <t:${Math.floor(value.confirm_until / 1000)}:R>.`;
  else if (value.status === "cancelled") description = "This challenge was cancelled. Ratings are unchanged.";
  else if (value.status === "complete") description = "Challenge results";
  else if (Date.now() > value.ends_at!) description = "Time is up. Checking final submissions and pending judgements.";
  else description = `Ends <t:${Math.floor(value.ends_at! / 1000)}:R>. Submission timestamps determine the deadline.`;
  if (!completed && players.some((player) => player.last_error)) {
    description += "\nCodeforces checks are delayed; ArugoBot will retry.";
  }
  const message: Message = {
    embeds: [{
      title: waiting ? "Confirm challenge" : value.status === "complete" ? "Challenge results" : "Codeforces challenge",
      description,
      color: waiting ? 0xf59e0b : completed ? 0x64748b : 0x3b82f6,
      fields: [
        { name: "Problem", value: `[${value.problem_id}. ${escapeMarkdown(value.problem_name)}](${problemUrl(value.problem_id)})` },
        { name: "Difficulty / duration", value: `${value.problem_rating} / ${value.minutes} minutes` },
        { name: "Participants", value: lines.join("\n") },
      ],
      footer: { text: "ArugoBot · results update about once per minute" },
    }],
    components: [],
  };
  if (waiting) {
    message.components = [{
      type: 1, components: [
        { type: 2, style: 3, label: "Ready", custom_id: `challenge:ready:${value.id}` },
        { type: 2, style: 2, label: "Not ready", custom_id: `challenge:unready:${value.id}` },
        { type: 2, style: 4, label: "Decline", custom_id: `challenge:decline:${value.id}` },
      ],
    }];
  } else if (!completed) {
    message.components = [{
      type: 1, components: [
        { type: 2, style: 1, label: "Check my result", custom_id: `challenge:check:${value.id}` },
        { type: 2, style: 4, label: "Give up", custom_id: `challenge:giveup:${value.id}`, disabled: Date.now() >= value.ends_at! },
        ...(players.some((entry) => entry.can_void && entry.outcome === "pending")
          ? [{ type: 2 as const, style: 2, label: "Cancel without rating", custom_id: `challenge:void:${value.id}` }] : []),
      ],
    }];
  }
  return message;
}

export async function setReady(db: D1Database, id: string, userId: string, ready: boolean): Promise<void> {
  const now = Date.now();
  const current = await challenge(db, id);
  if (!current || current.status !== "waiting") throw new UserError("This challenge is no longer waiting for confirmation.");
  if (current.confirm_until <= now) {
    await cancelWaiting(db, id);
    throw new UserError("The confirmation window has ended.");
  }
  const results = await db.batch([
    sql(db, `UPDATE participants SET ready = ? WHERE challenge_id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM challenges WHERE id = ? AND status = 'waiting' AND confirm_until > ?)`,
    ready ? 1 : 0, id, userId, id, now),
    sql(db, "UPDATE challenges SET version = version + 1, dirty = 1 WHERE id = ? AND status = 'waiting'", id),
    sql(db, `UPDATE challenges SET status = 'active', starts_at = ?, ends_at = ?,
      version = version + 1, dirty = 1 WHERE id = ? AND status = 'waiting' AND confirm_until > ?
      AND EXISTS (SELECT 1 FROM participants WHERE challenge_id = ?)
      AND NOT EXISTS (SELECT 1 FROM participants WHERE challenge_id = ? AND ready = 0)`,
    now, now + current.minutes * MINUTE, id, now, id, id),
    sql(db, `UPDATE participants SET next_poll = ? WHERE challenge_id = ?
      AND EXISTS (SELECT 1 FROM challenges WHERE id = ? AND status = 'active' AND starts_at = ?)`,
    now + MINUTE, id, id, now),
  ]);
  if (!results[0]!.meta.changes) throw new UserError("You are not waiting to join this challenge.");
}

export async function cancelWaiting(db: D1Database, id: string): Promise<void> {
  await db.batch([
    sql(db, `UPDATE challenges SET status = 'cancelled', version = version + 1, dirty = 1
      WHERE id = ? AND status = 'waiting'`, id),
    sql(db, `UPDATE participants SET outcome = 'void' WHERE challenge_id = ?
      AND EXISTS (SELECT 1 FROM challenges WHERE id = ? AND status = 'cancelled')`, id, id),
    sql(db, `DELETE FROM challenge_locks WHERE challenge_id = ?
      AND EXISTS (SELECT 1 FROM challenges WHERE id = ? AND status = 'cancelled')`, id, id),
  ]);
}

export async function resolveParticipant(
  db: D1Database, value: Challenge, player: Participant, outcome: Exclude<Outcome, "pending">,
): Promise<boolean> {
  const resolution = crypto.randomUUID();
  const now = Date.now();
  const [loss, gain] = ratingChanges(player.rating_start, value.problem_rating, value.minutes);
  const delta = outcome === "solved" ? gain : outcome === "void" ? 0 : loss;
  // A unique resolution claim gates every write in this transaction. A cron
  // check and a simultaneous button click cannot award or deduct twice.
  const results = await db.batch([
    sql(db, `UPDATE participants SET outcome = ?, resolution_id = ?, finished_at = ?,
      lease_owner = NULL, lease_until = 0, last_error = NULL, can_void = 0
      WHERE challenge_id = ? AND user_id = ? AND outcome = 'pending'
      AND EXISTS (SELECT 1 FROM challenges WHERE id = ? AND status = 'active')`,
    outcome, resolution, now, value.id, player.user_id, value.id),
    sql(db, `INSERT INTO rating_events(guild_id, user_id, challenge_id, problem_id, problem_name,
      old_rating, new_rating, outcome, created_at)
      SELECT ?, user_id, challenge_id, ?, ?, rating_start, rating_start + ?, ?, ?
      FROM participants WHERE challenge_id = ? AND user_id = ? AND resolution_id = ? AND outcome != 'void'`,
    value.guild_id, value.problem_id, value.problem_name, delta, outcome, now, value.id, player.user_id, resolution),
    sql(db, `UPDATE users SET rating = ? WHERE guild_id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM participants WHERE challenge_id = ? AND user_id = ? AND resolution_id = ?)`,
    player.rating_start + delta, value.guild_id, player.user_id, value.id, player.user_id, resolution),
    sql(db, `DELETE FROM challenge_locks WHERE guild_id = ? AND user_id = ? AND challenge_id = ?
      AND EXISTS (SELECT 1 FROM participants WHERE challenge_id = ? AND user_id = ? AND resolution_id = ?)`,
    value.guild_id, player.user_id, value.id, value.id, player.user_id, resolution),
    sql(db, `UPDATE challenges SET version = version + 1, dirty = 1 WHERE id = ?
      AND EXISTS (SELECT 1 FROM participants WHERE challenge_id = ? AND user_id = ? AND resolution_id = ?)`,
    value.id, value.id, player.user_id, resolution),
    sql(db, `UPDATE challenges SET status = 'complete' WHERE id = ? AND status = 'active'
      AND NOT EXISTS (SELECT 1 FROM participants WHERE challenge_id = ? AND outcome = 'pending')`, value.id, value.id),
  ]);
  return results[0]!.meta.changes === 1;
}

export async function checkParticipant(db: D1Database, cf: Codeforces, id: string, userId: string): Promise<void> {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const player = await sql(db, `UPDATE participants SET lease_owner = ?, lease_until = ?
    WHERE challenge_id = ? AND user_id = ? AND outcome = 'pending' AND lease_until <= ?
    AND EXISTS (SELECT 1 FROM challenges WHERE id = ? AND status = 'active') RETURNING *`,
  owner, now + 30_000, id, userId, now, id).first<Participant>();
  if (!player) return;
  const current = (await challenge(db, id))!;
  try {
    const submissions = await cf.contestSubmissions(player.handle, problemParts(current.problem_id).contestId, player.scan_from);
    const eligible = submissions.filter((submission) => submissionProblem(submission) === current.problem_id
      && submission.creationTimeSeconds * 1000 >= current.starts_at!
      && submission.creationTimeSeconds * 1000 <= current.ends_at!);
    if (eligible.some((submission) => submission.verdict === "OK")) {
      await resolveParticipant(db, current, player, "solved");
      return;
    }
    const testing = Boolean(player.saw_testing) || eligible.some((entry) => !entry.verdict || entry.verdict === "TESTING");
    const more = submissions.length === 100
      && submissions[submissions.length - 1]!.creationTimeSeconds * 1000 >= current.starts_at!;
    const ended = Date.now() >= current.ends_at!;
    if (ended && !more && !testing) {
      await resolveParticipant(db, current, player, "failed");
    } else if (ended && Date.now() >= current.ends_at! + 5 * MINUTE && (more || testing)) {
      // Do not invent a loss when Codeforces cannot provide a final verdict.
      await resolveParticipant(db, current, player, "void");
    } else {
      await sql(db, `UPDATE participants SET scan_from = ?, saw_testing = ?, next_poll = ?,
        last_error = NULL, can_void = 0 WHERE challenge_id = ? AND user_id = ? AND lease_owner = ? AND outcome = 'pending'`,
      more ? player.scan_from + 100 : 1, more && testing ? 1 : 0,
      Date.now() + (more ? 2100 : MINUTE), id, userId, owner).run();
      // Mark the end of a challenge visibly even while judging is pending.
      if (ended || player.last_error) {
        await sql(db, "UPDATE challenges SET dirty = 1, version = version + 1 WHERE id = ?", id).run();
      }
    }
  } catch (error) {
    if (Date.now() >= current.ends_at! + 5 * MINUTE) {
      await resolveParticipant(db, current, player, "void");
    } else {
      await db.batch([
        sql(db, `UPDATE participants SET last_error = ?, can_void = ?, next_poll = ?
          WHERE challenge_id = ? AND user_id = ? AND lease_owner = ? AND outcome = 'pending'`,
        errorMessage(error), error instanceof CodeforcesError && error.allowCancellation ? 1 : 0,
        Date.now() + MINUTE, id, userId, owner),
        sql(db, "UPDATE challenges SET dirty = 1, version = version + 1 WHERE id = ?", id),
      ]);
    }
  } finally {
    await sql(db, `UPDATE participants SET lease_owner = NULL, lease_until = 0
      WHERE challenge_id = ? AND user_id = ? AND lease_owner = ?`, id, userId, owner).run();
  }
}

export async function publishChallenge(db: D1Database, discord: Discord, id: string): Promise<void> {
  const owner = crypto.randomUUID();
  const current = await sql(db, `UPDATE challenges SET publish_owner = ?, publish_until = ?
    WHERE id = ? AND dirty = 1 AND message_id IS NOT NULL AND publish_until <= ? RETURNING *`,
  owner, Date.now() + 30_000, id, Date.now()).first<Challenge>();
  if (!current?.message_id) return;
  let retryAt = 0;
  try {
    await discord.edit(current.channel_id, current.message_id, challengeMessage(current, await participants(db, id)));
    // A state change while the request was in flight must keep the message dirty.
    await sql(db, "UPDATE challenges SET dirty = 0 WHERE id = ? AND version = ? AND publish_owner = ?",
      id, current.version, owner).run();
  } catch (error) {
    if (error instanceof DiscordError && error.status === 404) {
      await sql(db, "UPDATE challenges SET message_id = NULL, dirty = 0 WHERE id = ?", id).run();
    } else {
      retryAt = Date.now() + (error instanceof DiscordError && error.status === 403 ? 15 * MINUTE : MINUTE);
      console.error("Challenge message update delayed:", errorMessage(error));
    }
  } finally {
    await sql(db, "UPDATE challenges SET publish_owner = NULL, publish_until = ? WHERE id = ? AND publish_owner = ?",
      retryAt, id, owner).run();
  }
}
