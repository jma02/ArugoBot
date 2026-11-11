import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  cancelWaiting, checkParticipant, createChallenge, publishChallenge, resolveParticipant, setReady,
} from "../src/challenges";
import { Codeforces, CodeforcesError, requestSync, syncAccount } from "../src/codeforces";
import { handleInteraction, historyMessage, leaderboardMessage } from "../src/commands";
import { challenge, participants, sql, user } from "../src/database";
import { Discord } from "../src/discord";
import { checkRegistration, completeRegistration } from "../src/registration";
import { consumeJobs, enqueueJobs, scheduledTick } from "../src/scheduler";
import type { BackgroundJob, Challenge, Env, Interaction, QueuedJob, Registration, Submission, UserRow } from "../src/types";

const problem = { id: "1000A", contestId: 1000, index: "A", name: "Codehorses T-shirts", rating: 1500 };
const discord = () => {
  const client = new Discord(env);
  vi.spyOn(client, "send").mockResolvedValue({ id: "message-id" });
  vi.spyOn(client, "edit").mockResolvedValue({ id: "message-id" });
  return client;
};

async function addUser(id = "10", handle = `handle${id}`, guild = "1"): Promise<UserRow> {
  await sql(env.DB, `INSERT INTO users(guild_id,user_id,handle,rating,registration_id,created_at) VALUES (?,?,?,1500,?,?)`,
    guild, id, handle, crypto.randomUUID(), Date.now()).run();
  return (await user(env.DB, guild, id))!;
}

async function waiting(ids = ["10"]): Promise<Challenge> {
  const users = [];
  for (const id of ids) users.push(await addUser(id));
  return createChallenge(env.DB, discord(), "1", "2", ids[0]!, problem, 80, users);
}

async function running(ids = ["10"], ended = false): Promise<Challenge> {
  const value = await waiting(ids);
  for (const id of ids) await setReady(env.DB, value.id, id, true);
  const now = Math.floor(Date.now() / 1000) * 1000;
  await sql(env.DB, "UPDATE challenges SET starts_at = ?, ends_at = ? WHERE id = ?",
    now - 120_000, ended ? now - 10_000 : now + 600_000, value.id).run();
  return (await challenge(env.DB, value.id))!;
}

function submission(time: number, verdict = "OK", id = 100): Submission {
  return { id, creationTimeSeconds: Math.floor(time / 1000), verdict, contestId: 1000, problem: { contestId: 1000, index: "A" } };
}

function cfReturning(results: Submission[]): Codeforces {
  return { contestSubmissions: vi.fn().mockResolvedValue(results) } as unknown as Codeforces;
}

async function eventCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS count FROM rating_events").first<{ count: number }>())!.count;
}

describe("challenge lifecycle and transactional ratings", () => {
  it("starts exactly once when all participants confirm, and prevents overlapping challenges", async () => {
    const value = await waiting(["10", "11"]);
    await Promise.all([setReady(env.DB, value.id, "10", true), setReady(env.DB, value.id, "11", true)]);
    const active = (await challenge(env.DB, value.id))!;
    expect(active.status).toBe("active");
    expect(active.ends_at! - active.starts_at!).toBe(80 * 60_000);
    await expect(createChallenge(env.DB, discord(), "1", "2", "10", problem, 80,
      [(await user(env.DB, "1", "10"))!])).rejects.toThrow("already in a challenge");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM challenges").first<{ count: number }>())!.count).toBe(1);
  });

  it("cancels expired confirmations and releases every participant without changing ratings", async () => {
    const value = await waiting(["10", "11"]);
    await sql(env.DB, "UPDATE challenges SET confirm_until = ? WHERE id = ?", Date.now() - 1, value.id).run();
    await expect(setReady(env.DB, value.id, "10", true)).rejects.toThrow("window has ended");
    expect((await challenge(env.DB, value.id))!.status).toBe("cancelled");
    expect(await env.DB.prepare("SELECT * FROM challenge_locks").first()).toBeNull();
    expect(await eventCount()).toBe(0);
    expect((await user(env.DB, "1", "10"))!.rating).toBe(1500);
  });

  it("applies a concurrent solve/give-up race only once", async () => {
    const value = await running();
    const player = (await participants(env.DB, value.id))[0]!;
    const applied = await Promise.all([
      resolveParticipant(env.DB, value, player, "solved"),
      resolveParticipant(env.DB, value, player, "gave_up"),
    ]);
    expect(applied.filter(Boolean)).toHaveLength(1);
    expect(await eventCount()).toBe(1);
    expect([1513, 1484]).toContain((await user(env.DB, "1", "10"))!.rating);
    expect((await challenge(env.DB, value.id))!.status).toBe("complete");
    expect(await env.DB.prepare("SELECT * FROM challenge_locks").first()).toBeNull();
    await resolveParticipant(env.DB, value, player, "failed");
    expect(await eventCount()).toBe(1);
  });

  it("does not let an old result overwrite the rating from a later challenge", async () => {
    const first = await running();
    const stale = (await participants(env.DB, first.id))[0]!;
    await resolveParticipant(env.DB, first, stale, "solved");
    const second = await createChallenge(env.DB, discord(), "1", "2", "10", problem, 80, [(await user(env.DB, "1", "10"))!]);
    await setReady(env.DB, second.id, "10", true);
    await resolveParticipant(env.DB, (await challenge(env.DB, second.id))!, (await participants(env.DB, second.id))[0]!, "solved");
    const rating = (await user(env.DB, "1", "10"))!.rating;
    await resolveParticipant(env.DB, first, stale, "failed");
    expect((await user(env.DB, "1", "10"))!.rating).toBe(rating);
    expect(await eventCount()).toBe(2);
  });

  it("accepts an on-time submission discovered after the deadline", async () => {
    const value = await running(["10"], true);
    await checkParticipant(env.DB, cfReturning([submission(value.ends_at! - 1000)]), value.id, "10");
    expect((await user(env.DB, "1", "10"))!.rating).toBe(1513);
  });

  it("rejects submissions from before the start and after the deadline", async () => {
    const value = await running(["10"], true);
    await checkParticipant(env.DB, cfReturning([
      submission(value.starts_at! - 1000), submission(value.ends_at! + 1000, "OK", 101),
    ]), value.id, "10");
    expect((await user(env.DB, "1", "10"))!.rating).toBe(1484);
    expect(await eventCount()).toBe(1);
  });

  it("waits for judging, then voids unjudgeable results without inventing a loss", async () => {
    const value = await running(["10"], true);
    const cf = cfReturning([submission(value.ends_at! - 1000, "TESTING")]);
    await checkParticipant(env.DB, cf, value.id, "10");
    expect((await participants(env.DB, value.id))[0]!.outcome).toBe("pending");
    expect(await eventCount()).toBe(0);
    await sql(env.DB, "UPDATE challenges SET ends_at = ? WHERE id = ?", Date.now() - 360_000, value.id).run();
    const updated = (await challenge(env.DB, value.id))!;
    // Keep the queued submission inside the adjusted test interval.
    await sql(env.DB, "UPDATE challenges SET starts_at = ? WHERE id = ?", updated.ends_at! - 60_000, value.id).run();
    await checkParticipant(env.DB, cfReturning([submission(updated.ends_at! - 1000, "TESTING")]), value.id, "10");
    expect((await participants(env.DB, value.id))[0]!.outcome).toBe("void");
    expect((await user(env.DB, "1", "10"))!.rating).toBe(1500);
    expect(await eventCount()).toBe(0);
  });

  it("paginates before deciding that no accepted submission exists", async () => {
    const value = await running(["10"], true);
    const firstPage = Array.from({ length: 100 }, (_, index) => submission(value.starts_at! + 1000, "WRONG_ANSWER", 1000 - index));
    const cf = { contestSubmissions: vi.fn().mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([submission(value.starts_at! + 1000)]) } as unknown as Codeforces;
    await checkParticipant(env.DB, cf, value.id, "10");
    expect((await participants(env.DB, value.id))[0]!.scan_from).toBe(101);
    expect(await eventCount()).toBe(0);
    await checkParticipant(env.DB, cf, value.id, "10");
    expect((await user(env.DB, "1", "10"))!.rating).toBe(1513);
  });

  it("distinguishes a real Codeforces outage from the bot's own request backlog", async () => {
    const value = await running();
    const cf = { contestSubmissions: vi.fn().mockRejectedValue(new CodeforcesError("Offline")) } as unknown as Codeforces;
    await checkParticipant(env.DB, cf, value.id, "10");
    expect((await participants(env.DB, value.id))[0]!.can_void).toBe(1);
    vi.mocked(cf.contestSubmissions).mockRejectedValue(new CodeforcesError("Busy", true, false));
    await checkParticipant(env.DB, cf, value.id, "10");
    expect((await participants(env.DB, value.id))[0]!.can_void).toBe(0);
    expect(await eventCount()).toBe(0);
  });

  it("preserves a dirty update when state changes while a Discord edit is in flight", async () => {
    const value = await running();
    const client = discord();
    vi.mocked(client.edit).mockImplementation(async () => {
      await sql(env.DB, "UPDATE challenges SET version = version + 1, dirty = 1 WHERE id = ?", value.id).run();
      return { id: "message-id" };
    });
    await publishChallenge(env.DB, client, value.id);
    expect((await challenge(env.DB, value.id))!.dirty).toBe(1);
  });
});

async function pendingRegistration(userId = "10", handle = "tourist"): Promise<Registration> {
  const id = crypto.randomUUID();
  const start = Math.floor(Date.now() / 1000) * 1000 - 30_000;
  await sql(env.DB, `INSERT INTO registrations(id,guild_id,user_id,handle,channel_id,problem_id,created_at,submit_until,next_poll)
    VALUES (?,'1',?,?,'2','1000A',?,?,?)`, id, userId, handle, start, start + 60_000, Date.now()).run();
  return (await sql(env.DB, "SELECT * FROM registrations WHERE id = ?", id).first<Registration>())!;
}

describe("handle verification and Codeforces history", () => {
  it("links only a compilation error for the specified problem inside the verification window", async () => {
    const pending = await pendingRegistration();
    await checkRegistration(env.DB, cfReturning([submission(pending.created_at + 1000, "COMPILATION_ERROR")]), pending.id);
    expect((await user(env.DB, "1", "10"))!.handle).toBe("tourist");
    expect((await user(env.DB, "1", "10"))!.rating).toBe(1500);
    expect(await sql(env.DB, "SELECT handle FROM cf_accounts WHERE handle = 'tourist'").first()).not.toBeNull();
  });

  it("does not accept an old verification submission", async () => {
    const pending = await pendingRegistration();
    await sql(env.DB, "UPDATE registrations SET submit_until = ? WHERE id = ?", Date.now() - 1000, pending.id).run();
    await checkRegistration(env.DB, cfReturning([submission(pending.created_at - 1000, "COMPILATION_ERROR")]), pending.id);
    expect(await user(env.DB, "1", "10")).toBeNull();
    expect((await sql(env.DB, "SELECT status FROM registrations WHERE id = ?", pending.id).first<{ status: string }>())!.status).toBe("expired");
  });

  it("rolls back the losing transaction when two users verify the same handle", async () => {
    const first = await pendingRegistration("10", "tourist");
    const second = await pendingRegistration("11", "TOURIST");
    await env.DB.batch([first, second].map((entry) =>
      sql(env.DB, "UPDATE registrations SET lease_owner = ? WHERE id = ?", entry.id, entry.id)));
    const results = await Promise.allSettled([
      completeRegistration(env.DB, first, first.id), completeRegistration(env.DB, second, second.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>())!.count).toBe(1);
  });

  it("imports history in bounded pages and revisits submissions that were still being judged", async () => {
    await requestSync(env.DB, ["tourist"]);
    const page = Array.from({ length: 200 }, (_, index) => ({
      ...submission(Date.now() - index * 1000, index === 10 ? "TESTING" : "OK", 400 - index),
      problem: { contestId: 1000, index: `A${400 - index}` },
    }));
    const cf = { submissions: vi.fn().mockResolvedValueOnce(page)
      .mockResolvedValueOnce([{ ...submission(Date.now(), "OK", 200), problem: { contestId: 1000, index: "A200" } }]) } as unknown as Codeforces;
    await syncAccount(env.DB, cf, "tourist");
    expect((await env.DB.prepare("SELECT cursor FROM cf_accounts").first<{ cursor: number }>())!.cursor).toBe(201);
    await syncAccount(env.DB, cf, "tourist");
    expect((await env.DB.prepare("SELECT next_sync FROM cf_accounts").first<{ next_sync: number | null }>())!.next_sync).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM solved WHERE problem_id = '1000A390'").first()).toBeNull();
    await env.DB.prepare("UPDATE cf_accounts SET synced_at = 0").run();
    await requestSync(env.DB, ["TOURIST"]);
    expect((await env.DB.prepare("SELECT stop_id FROM cf_accounts").first<{ stop_id: number }>())!.stop_id).toBe(390);
    vi.mocked(cf.submissions).mockResolvedValue([{
      ...submission(Date.now(), "OK", 390), problem: { contestId: 1000, index: "A390" },
    }]);
    await syncAccount(env.DB, cf, "tourist");
    expect(await env.DB.prepare("SELECT 1 FROM solved WHERE problem_id = '1000A390'").first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT * FROM pending_submissions").first()).toBeNull();
  });

  it("honors Codeforces Retry-After across separate client instances", async () => {
    const transport = vi.fn().mockImplementation(async () => Response.json({}, { status: 429, headers: { "Retry-After": "30" } }));
    await expect(new Codeforces(env.DB, transport, async () => {}).canonicalHandle("tourist")).rejects.toThrow("limiting requests");
    await expect(new Codeforces(env.DB, transport, async () => {}).canonicalHandle("tourist")).rejects.toThrow("busy");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("logs Codeforces transport failures without exposing the requested handle", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const transport = vi.fn().mockRejectedValue(
      new Error("Failed to fetch https://codeforces.com/api/user.info?handles=privateHandle"),
    );
    await expect(new Codeforces(env.DB, transport).canonicalHandle("tourist")).rejects.toThrow("could not be reached");
    expect(log).toHaveBeenCalledWith("Codeforces transport failure:", "Error: Failed to fetch [URL]");
  });

  it("calls the fetch transport with the Workers global receiver", async () => {
    const transport = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({ status: "OK", result: [{ handle: "tourist" }] }));
    });
    expect(await new Codeforces(env.DB, transport).canonicalHandle("tourist")).toBe("tourist");
  });
});

function button(customId: string, userId = "10", guildId = "1"): Interaction {
  return {
    id: crypto.randomUUID(), application_id: env.DISCORD_APPLICATION_ID, type: 3, token: "test-token",
    guild_id: guildId, channel_id: "2", member: { user: { id: userId, username: "tester" } },
    message: { id: "message-id" }, data: { custom_id: customId },
  };
}

describe("command permissions and views", () => {
  it("creates a five-player slash challenge within the Free D1 query budget", async () => {
    for (const id of ["10", "11", "12", "13", "14"]) {
      const linked = await addUser(id);
      await sql(env.DB, "INSERT INTO cf_accounts(handle,synced_at) VALUES (?,?)", linked.handle, Date.now()).run();
    }
    const transport = vi.mocked(fetch).mockImplementation(async () => Response.json({ id: "created-message" }));
    let queries = 0;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") return (text: string) => { queries++; return target.prepare(text); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await handleInteraction({ ...env, DB: db }, {
      ...button(""), type: 2,
      data: {
        name: "challenge", options: [
          { name: "problem", value: "1000A" }, { name: "minutes", value: 80 },
          ...["11", "12", "13", "14"].map((id, index) => ({ name: `opponent${index + 1}`, value: id })),
        ],
      },
    });
    const created = await env.DB.prepare("SELECT id,status FROM challenges").first<{ id: string; status: string }>();
    expect(created?.status).toBe("waiting");
    expect(await participants(env.DB, created!.id)).toHaveLength(5);
    expect(queries).toBeLessThanOrEqual(50);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.every(([url]) => !String(url).includes("codeforces.com"))).toBe(true);
  });

  it("filters solved problems from suggestions and sends a real PNG for /rating", async () => {
    const linked = await addUser();
    await sql(env.DB, "INSERT INTO cf_accounts(handle,synced_at) VALUES (?,?)", linked.handle, Date.now()).run();
    const transport = vi.mocked(fetch).mockImplementation(async () => Response.json({ id: "reply" }));
    await handleInteraction(env, { ...button(""), type: 2,
      data: { name: "suggest", options: [{ name: "rating", value: 1500 }] } });
    const payload = JSON.parse(String(transport.mock.calls[0]![1]!.body));
    expect(payload.embeds[0].title).toContain("1500");
    expect(payload.embeds[0].description.split("\n")).toHaveLength(10);
    const firstProblem = /\[(\d+[A-Z]\d*)\./.exec(payload.embeds[0].description)![1]!;
    await sql(env.DB, "INSERT INTO solved(handle,problem_id) VALUES (?,?)", linked.handle, firstProblem).run();
    await env.DB.prepare("DELETE FROM cooldowns").run();
    await handleInteraction(env, { ...button(""), type: 2,
      data: { name: "suggest", options: [{ name: "rating", value: 1500 }] } });
    expect(JSON.parse(String(transport.mock.calls[1]![1]!.body)).embeds[0].description).not.toContain(`[${firstProblem}.`);
    await env.DB.prepare("DELETE FROM cooldowns").run();
    await handleInteraction(env, { ...button(""), type: 2, data: { name: "rating" } });
    const form = transport.mock.calls[2]![1]!.body as FormData;
    const file = form.get("files[0]") as File;
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it("prevents other users and other guilds from changing a challenge", async () => {
    const value = await running();
    const transport = vi.mocked(fetch).mockImplementation(async () => Response.json({ id: "reply" }));
    await handleInteraction(env, button(`challenge:giveup:${value.id}`, "99"));
    await handleInteraction(env, button(`challenge:giveup:${value.id}`, "10", "another-server"));
    expect((await participants(env.DB, value.id))[0]!.outcome).toBe("pending");
    expect(await eventCount()).toBe(0);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("prevents unlinking during a challenge and rejects stale confirmations", async () => {
    const value = await running();
    const linked = (await user(env.DB, "1", "10"))!;
    vi.mocked(fetch).mockImplementation(async () => Response.json({ id: "reply" }));
    await handleInteraction(env, button(`unlink:10:${linked.registration_id}`));
    expect(await user(env.DB, "1", "10")).not.toBeNull();
    await resolveParticipant(env.DB, value, (await participants(env.DB, value.id))[0]!, "solved");
    await handleInteraction(env, button("unlink:10:old-registration"));
    expect(await user(env.DB, "1", "10")).not.toBeNull();
    await handleInteraction(env, button(`unlink:10:${linked.registration_id}`));
    expect(await user(env.DB, "1", "10")).toBeNull();
    expect(await eventCount()).toBe(0);
  });

  it("keeps leaderboards and histories scoped to the server", async () => {
    await addUser("10", "tourist", "1");
    await addUser("99", "other", "another-server");
    const leaderboard = await leaderboardMessage(env.DB, "1", 1, "10");
    expect(leaderboard.embeds![0]!.description).toContain("<@10>");
    expect(leaderboard.embeds![0]!.description).not.toContain("<@99>");
    const history = await historyMessage(env.DB, "1", "10", 1, "10");
    expect(history.embeds![0]!.description).toContain("No challenges");
    await expect(historyMessage(env.DB, "1", "99", 1, "10")).rejects.toThrow("not linked");
  });
});

describe("scheduled work and queue redelivery", () => {
  function queuedEnv(): { environment: Env; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn().mockResolvedValue(undefined);
    return { environment: { ...env, JOBS: { sendBatch: send } as unknown as Queue<QueuedJob> }, send };
  }

  it("enqueues durable work once, without making Codeforces calls inside cron", async () => {
    await requestSync(env.DB, ["tourist"]);
    const { environment, send } = queuedEnv();
    await scheduledTick(environment);
    await scheduledTick(environment);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0][0].body).toMatchObject({ kind: "account", id: "tourist" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("recovers when a queue send fails instead of abandoning the job", async () => {
    await requestSync(env.DB, ["tourist"]);
    const { environment, send } = queuedEnv();
    send.mockRejectedValueOnce(new Error("Queue unavailable"));
    await expect(scheduledTick(environment)).rejects.toThrow("Queue unavailable");
    await scheduledTick(environment);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("ignores duplicate queue delivery after recording the result", async () => {
    const value = await running(["10"], true);
    const { environment, send } = queuedEnv();
    const job: BackgroundJob = { kind: "participant", id: value.id, userId: "10" };
    await enqueueJobs(environment, [job]);
    const body = send.mock.calls[0]![0][0].body as QueuedJob;
    const transport = vi.mocked(fetch).mockImplementation(async (url) => String(url).includes("codeforces.com")
      ? Response.json({ status: "OK", result: [submission(value.ends_at! - 1000)] })
      : Response.json({ id: "message-id" }));
    const ack = vi.fn(), retry = vi.fn();
    const batch = { messages: [{ body, ack, retry }] } as unknown as MessageBatch<QueuedJob>;
    await consumeJobs(batch, environment);
    await consumeJobs(batch, environment);
    expect((await user(env.DB, "1", "10"))!.rating).toBe(1513);
    expect(await eventCount()).toBe(1);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
  });

  it("queues the next account-history page with a fresh lease", async () => {
    await requestSync(env.DB, ["tourist"]);
    const { environment, send } = queuedEnv();
    await enqueueJobs(environment, [{ kind: "account", id: "tourist" }]);
    const body = send.mock.calls[0]![0][0].body as QueuedJob;
    vi.mocked(fetch).mockImplementation(async () => Response.json({
      status: "OK",
      result: Array.from({ length: 200 }, (_, index) => submission(Date.now(), "OK", 1000 - index)),
    }));
    const ack = vi.fn(), retry = vi.fn();
    await consumeJobs({ messages: [{ body, ack, retry }] } as unknown as MessageBatch<QueuedJob>, environment);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0][0].body).toMatchObject({ kind: "account", id: "tourist" });
    expect(send.mock.calls[1]![0][0].body.queueOwner).not.toBe(body.queueOwner);
    expect(send.mock.calls[1]![1]).toEqual({ delaySeconds: 3 });
    expect((await env.DB.prepare("SELECT cursor FROM cf_accounts").first<{ cursor: number }>())!.cursor).toBe(201);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
