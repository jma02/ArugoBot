import { Catalog, sample } from "./catalog";
import { ratingChart } from "./chart";
import {
  cancelWaiting, checkParticipant, createChallenge, publishChallenge, resolveParticipant, setReady,
} from "./challenges";
import { Codeforces, ensureFreshAccounts, solvedProblems } from "./codeforces";
import { challenge, cooldown, participants, sql, user } from "./database";
import { Discord, messageLink } from "./discord";
import { ratingColor } from "./rating";
import { checkRegistration, createRegistration, publishRegistration } from "./registration";
import {
  UserError, actor, escapeMarkdown, option, problemUrl,
  type Env, type Interaction, type Message, type Registration, type UserRow,
} from "./types";

const HELP = {
  title: "ArugoBot",
  description: [
    "**/register** — verify and link your Codeforces handle.",
    "**/challenge** — choose a problem ID or rating, a duration, and up to four friends.",
    "**/suggest** — find problems none of the selected participants have solved.",
    "**/rating** — see your rating graph.",
    "**/history** — view challenges and rating changes.",
    "**/leaderboard** — see this server's rankings.",
    "**/unlink** — erase your rating and linked handle in this server.",
    "",
    "New accounts start at **1500**. Use buttons to confirm challenges and check results.",
    "Results update about once per minute; submission timestamps determine whether you finished in time.",
  ].join("\n"),
  color: 0x3b82f6,
};

function selectedUsers(interaction: Interaction): string[] {
  const ids = [actor(interaction).id];
  for (let index = 1; index <= 4; index++) {
    const id = option(interaction, `opponent${index}`);
    if (id !== undefined) {
      if (typeof id !== "string" || !/^\d{1,20}$/.test(id)) throw new UserError("Choose a valid participant.");
      if (interaction.data?.resolved?.users?.[id]?.bot) throw new UserError("Bots cannot join Codeforces challenges.");
      ids.push(id);
    }
  }
  return [...new Set(ids)];
}

async function linkedGroup(env: Env, interaction: Interaction): Promise<UserRow[]> {
  const ids = selectedUsers(interaction);
  const rows = (await sql(env.DB, `SELECT * FROM users
    WHERE guild_id = ? AND user_id IN (SELECT value FROM json_each(?))`,
  interaction.guild_id!, JSON.stringify(ids)).all<UserRow>()).results;
  if (rows.length !== ids.length) throw new UserError("Everyone must link a Codeforces handle with /register first.");
  return ids.map((id) => rows.find((entry) => entry.user_id === id)!);
}

function pageNumber(value: unknown): number {
  const page = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new UserError("Choose a page from 1 to 1000.");
  return page;
}

function pages(prefix: string, page: number, total: number, owner: string): Message["components"] {
  if (total <= 10) return [];
  return [{
    type: 1, components: [
      { type: 2, style: 2, label: "Previous", custom_id: `${prefix}:${page - 1}:${owner}`, disabled: page <= 1 },
      { type: 2, style: 2, label: "Next", custom_id: `${prefix}:${page + 1}:${owner}`, disabled: page * 10 >= total || page >= 1000 },
    ],
  }];
}

export async function historyMessage(db: D1Database, guildId: string, userId: string, page: number, owner: string): Promise<Message> {
  const linked = await user(db, guildId, userId);
  if (!linked) throw new UserError("That user has not linked a Codeforces handle.");
  const count = (await sql(db, "SELECT COUNT(*) AS count FROM rating_events WHERE guild_id = ? AND user_id = ?",
    guildId, userId).first<{ count: number }>())!.count;
  const rows = (await sql(db, `SELECT problem_id, problem_name, old_rating, new_rating, outcome FROM rating_events
    WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 10 OFFSET ?`, guildId, userId, (page - 1) * 10)
    .all<{ problem_id: string; problem_name: string; old_rating: number; new_rating: number; outcome: string }>()).results;
  if (!rows.length && page > 1) throw new UserError("That history page is empty.");
  return {
    embeds: [{
      title: "Challenge history",
      description: `<@${userId}>\n\n` + (rows.map((entry) => {
        const delta = entry.new_rating - entry.old_rating;
        return `[${entry.problem_id}. ${escapeMarkdown(entry.problem_name.slice(0, 100))}](${problemUrl(entry.problem_id)})`
          + `\n${entry.old_rating} → **${entry.new_rating}** (${delta >= 0 ? "+" : ""}${delta})`;
      }).join("\n\n") || "No challenges yet."),
      color: ratingColor(linked.rating),
      footer: { text: `Page ${page} of ${Math.max(1, Math.ceil(count / 10))}` },
    }],
    components: pages(`history:${userId}`, page, count, owner),
  };
}

export async function leaderboardMessage(db: D1Database, guildId: string, page: number, owner: string): Promise<Message> {
  const count = (await sql(db, "SELECT COUNT(*) AS count FROM users WHERE guild_id = ?", guildId).first<{ count: number }>())!.count;
  const rows = (await sql(db, `SELECT user_id, rating FROM users WHERE guild_id = ?
    ORDER BY rating DESC, user_id LIMIT 10 OFFSET ?`, guildId, (page - 1) * 10)
    .all<{ user_id: string; rating: number }>()).results;
  if (!rows.length && page > 1) throw new UserError("That leaderboard page is empty.");
  return {
    embeds: [{
      title: "Server leaderboard",
      description: rows.map((entry, index) => {
        const rank = (page - 1) * 10 + index + 1;
        return `${["🥇", "🥈", "🥉"][rank - 1] ?? `${rank}.`} <@${entry.user_id}> — **${entry.rating}**`;
      }).join("\n") || "No linked accounts yet. Use /register to join.",
      color: 0xf59e0b,
      footer: { text: `Page ${page} of ${Math.max(1, Math.ceil(count / 10))}` },
    }],
    components: pages("leaderboard", page, count, owner),
  };
}

async function runCommand(env: Env, discord: Discord, cf: Codeforces, interaction: Interaction): Promise<void> {
  const guildId = interaction.guild_id!;
  const userId = actor(interaction).id;
  const channelId = interaction.channel_id!;
  switch (interaction.data?.name) {
    case "ping":
      await discord.response(interaction, { content: "Pong!" });
      return;
    case "help":
      await discord.response(interaction, { embeds: [HELP] });
      return;
    case "register": {
      const handle = option(interaction, "handle");
      if (typeof handle !== "string") throw new UserError("Enter your Codeforces handle.");
      const registration = await createRegistration(env, discord, cf, guildId, channelId, userId, handle);
      await discord.response(interaction, { content: registration.message_id
        ? `Verify your handle here: ${messageLink(guildId, registration.channel_id, registration.message_id)}`
        : "Your verification is being prepared. Please try again shortly." });
      return;
    }
    case "unlink": {
      const linked = await user(env.DB, guildId, userId);
      if (!linked) throw new UserError("You do not have a linked Codeforces handle.");
      await discord.response(interaction, {
        embeds: [{
          title: "Unlink your handle?",
          description: "This erases your ArugoBot rating and challenge history in this server. It cannot be undone.",
          color: 0xef4444,
        }],
        components: [{
          type: 1, components: [
            { type: 2, style: 4, label: "Unlink and erase progress", custom_id: `unlink:${userId}:${linked.registration_id}` },
            { type: 2, style: 2, label: "Keep account", custom_id: `keep:${userId}` },
          ],
        }],
      });
      return;
    }
    case "challenge":
    case "suggest": {
      const group = await linkedGroup(env, interaction);
      const ids = JSON.stringify(group.map((entry) => entry.user_id));
      const isChallenge = interaction.data.name === "challenge";
      if (isChallenge && await sql(env.DB, `SELECT 1 FROM challenge_locks WHERE guild_id = ?
        AND user_id IN (SELECT value FROM json_each(?)) LIMIT 1`, guildId, ids).first()) {
        throw new UserError("Someone is already in a challenge in this server.");
      }
      const handles = group.map((entry) => entry.handle);
      await ensureFreshAccounts(env.DB, cf, handles);
      const solved = await solvedProblems(env.DB, handles);
      const catalog = new Catalog(env.ASSETS);
      if (!isChallenge) {
        const rating = Number(option(interaction, "rating"));
        const choices = sample((await catalog.bucket(rating)).filter((problem) => !solved.has(problem.id)), 10);
        await discord.response(interaction, {
          embeds: [{
            title: `Problem suggestions · ${rating}`,
            description: choices.map((problem) =>
              `[${problem.id}. ${escapeMarkdown(problem.name.slice(0, 120))}](${problemUrl(problem.id)})`).join("\n")
              || "No unsolved problems were found at that rating. Try another rating.",
            color: ratingColor(rating),
            footer: { text: `For ${handles.join(", ")}` },
          }],
        });
        return;
      }
      const prior = new Set((await sql(env.DB, `SELECT DISTINCT problem_id FROM rating_events
        WHERE guild_id = ? AND user_id IN (SELECT value FROM json_each(?))`, guildId, ids)
        .all<{ problem_id: string }>()).results.map((entry) => entry.problem_id));
      const input = String(option(interaction, "problem") ?? "").trim().toUpperCase();
      const problem = /^\d+$/.test(input)
        ? sample((await catalog.bucket(Number(input))).filter((entry) => !solved.has(entry.id) && !prior.has(entry.id)), 1)[0]
        : await catalog.problem(input);
      if (!problem) throw new UserError("No eligible problem was found at that rating. Try another rating.");
      if (solved.has(problem.id)) throw new UserError("Someone has already solved that problem on Codeforces.");
      if (prior.has(problem.id)) throw new UserError("Someone has already attempted that problem in an ArugoBot challenge.");
      const created = await createChallenge(env.DB, discord, guildId, channelId, userId,
        problem, Number(option(interaction, "minutes")), group);
      await discord.response(interaction, { content: `Challenge created: ${messageLink(guildId, channelId, created.message_id!)}` });
      return;
    }
    case "rating": {
      const target = String(option(interaction, "user") ?? userId);
      const linked = await user(env.DB, guildId, target);
      if (!linked) throw new UserError("That user has not linked a Codeforces handle.");
      const events = (await sql(env.DB, `SELECT old_rating, new_rating FROM rating_events
        WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 200`, guildId, target)
        .all<{ old_rating: number; new_rating: number }>()).results.reverse();
      const count = (await sql(env.DB, "SELECT COUNT(*) AS count FROM rating_events WHERE guild_id = ? AND user_id = ?",
        guildId, target).first<{ count: number }>())!.count;
      const values = events.length ? [events[0]!.old_rating, ...events.map((entry) => entry.new_rating)] : [linked.rating];
      await discord.response(interaction, {
        embeds: [{
          title: "Rating history",
          description: `<@${target}> — **${linked.rating}**`,
          color: ratingColor(linked.rating),
          image: { url: "attachment://rating.png" },
          footer: { text: count > 200 ? "Most recent 200 challenges · full history is available with /history" : `${count} challenges` },
        }],
      }, await ratingChart(values, Math.max(0, count - events.length)));
      return;
    }
    case "history":
      await discord.response(interaction, await historyMessage(env.DB, guildId,
        String(option(interaction, "user") ?? userId), pageNumber(option(interaction, "page")), userId));
      return;
    case "leaderboard":
      await discord.response(interaction, await leaderboardMessage(env.DB, guildId, pageNumber(option(interaction, "page")), userId));
      return;
    default:
      throw new UserError("That command is unavailable. Try /help.");
  }
}

async function runButton(env: Env, discord: Discord, cf: Codeforces, interaction: Interaction): Promise<void> {
  const userId = actor(interaction).id;
  const guildId = interaction.guild_id!;
  const [kind, action, id, owner] = (interaction.data?.custom_id ?? "").split(":");
  switch (kind) {
    case "keep":
      if (action !== userId) throw new UserError("This confirmation belongs to another user.");
      await discord.response(interaction, { content: "Your account was kept.", embeds: [], components: [] });
      return;
    case "unlink": {
      if (action !== userId || !id) throw new UserError("This confirmation belongs to another user.");
      const deleted = await sql(env.DB, `DELETE FROM users WHERE guild_id = ? AND user_id = ? AND registration_id = ?
        AND NOT EXISTS (SELECT 1 FROM challenge_locks WHERE guild_id = ? AND user_id = ?)`,
      guildId, userId, id, guildId, userId).run();
      if (!deleted.meta.changes) throw new UserError("Finish your active challenge first, or use /unlink to start a new confirmation.");
      await discord.response(interaction, { content: "Your handle, rating, and history have been removed from this server.", embeds: [], components: [] });
      return;
    }
    case "history":
      if (owner !== userId || !action) throw new UserError("Use /history to open your own page.");
      await discord.response(interaction, await historyMessage(env.DB, guildId, action, pageNumber(id), userId));
      return;
    case "leaderboard":
      if (id !== userId) throw new UserError("Use /leaderboard to open your own page.");
      await discord.response(interaction, await leaderboardMessage(env.DB, guildId, pageNumber(action), userId));
      return;
    case "verify": {
      const registration = await sql(env.DB, "SELECT * FROM registrations WHERE id = ?", action ?? "").first<Registration>();
      if (!registration || registration.guild_id !== guildId || registration.user_id !== userId
        || registration.message_id !== interaction.message?.id) {
        throw new UserError("This verification belongs to another user.");
      }
      if (!await cooldown(env.DB, `verify:${userId}`, 10_000)) throw new UserError("Please wait a few seconds before checking again.");
      await checkRegistration(env.DB, cf, registration.id);
      await publishRegistration(env.DB, discord, registration.id);
      const updated = (await sql(env.DB, "SELECT * FROM registrations WHERE id = ?", registration.id).first<Registration>())!;
      await discord.followup(interaction, updated.status === "pending"
        ? "No qualifying submission found yet. ArugoBot will keep checking until verification finishes."
        : updated.detail ?? "Verification finished.");
      return;
    }
    case "challenge": {
      const current = await challenge(env.DB, id ?? "");
      if (!current || current.guild_id !== guildId || current.message_id !== interaction.message?.id) {
        throw new UserError("That challenge is unavailable.");
      }
      const player = (await participants(env.DB, current.id)).find((entry) => entry.user_id === userId);
      if (!player) throw new UserError("Only participants can use these challenge buttons.");
      if (action === "ready" || action === "unready") {
        await setReady(env.DB, current.id, userId, action === "ready");
      } else if (action === "decline") {
        if (current.status !== "waiting") throw new UserError("This challenge has already started.");
        await cancelWaiting(env.DB, current.id);
      } else if (action === "check") {
        if (!await cooldown(env.DB, `check:${userId}`, 20_000)) throw new UserError("Please wait before checking again. Automatic checks are still running.");
        await checkParticipant(env.DB, cf, current.id, userId);
      } else if (action === "giveup" || action === "void") {
        if (current.status !== "active" || player.outcome !== "pending") throw new UserError("Your result has already been recorded.");
        if (action === "giveup" && Date.now() >= current.ends_at!) throw new UserError("Time is up. Use Check my result to verify your submissions.");
        if (action === "void" && !player.can_void) throw new UserError("Cancellation without a rating change is available when Codeforces cannot be reached.");
        await resolveParticipant(env.DB, current, player, action === "giveup" ? "gave_up" : "void");
      } else throw new UserError("That challenge action is unavailable.");
      await publishChallenge(env.DB, discord, current.id);
      return;
    }
    default:
      throw new UserError("That button is unavailable. Please run the command again.");
  }
}

export async function handleInteraction(env: Env, interaction: Interaction): Promise<void> {
  const discord = new Discord(env);
  try {
    const claimed = await sql(env.DB, "INSERT OR IGNORE INTO interactions(id, received_at) VALUES (?, ?)",
      interaction.id, Date.now()).run();
    if (!claimed.meta.changes) return;
    if (interaction.type === 2 && !["help", "ping"].includes(interaction.data?.name ?? "")
      && !await cooldown(env.DB, `command:${actor(interaction).id}`, 2_000)) {
      throw new UserError("Please wait a couple of seconds between commands.");
    }
    const cf = new Codeforces(env.DB);
    if (interaction.type === 2) await runCommand(env, discord, cf, interaction);
    else await runButton(env, discord, cf, interaction);
  } catch (error) {
    await discord.error(interaction, error);
  }
}
