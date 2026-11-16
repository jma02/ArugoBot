import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Catalog, sample, sampleRecentProblems } from "../src/catalog";
import { ratingChart } from "../src/chart";
import { COMMANDS } from "../src/command-schema";
import { ratingChanges } from "../src/rating";
import { problemUrl } from "../src/types";

describe("original ArugoBot ratings", () => {
  // Golden values evaluated from upstream's Python formula.
  it.each([
    [1500, 1500, 80, -16, 13],
    [1500, 1500, 40, -13, 17],
    [1500, 1500, 120, -20, 11],
    [1200, 2000, 60, -8, 160],
    [2500, 800, 40, -160, 6],
    [500, 3500, 120, -8, 160],
    [1900, 1900, 100, -18, 12],
    [1400, 1400, 60, -14, 15],
  ])("matches Python for rating %i / problem %i / %i minutes", (rating, problem, minutes, loss, gain) => {
    expect(ratingChanges(rating, problem, minutes)).toEqual([loss, gain]);
  });
});

it("produces a valid RGBA PNG with the expected decompressed dimensions", async () => {
  const png = await ratingChart([1500, 1513, 1497, 1520]);
  expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer);
  expect(view.getUint32(16)).toBe(400);
  expect(view.getUint32(20)).toBe(220);
  const data: Uint8Array[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.slice(offset + 4, offset + 8));
    if (type === "IDAT") data.push(png.slice(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const decompressed = new Response(new Blob(data).stream().pipeThrough(new DecompressionStream("deflate")));
  const raw = new Uint8Array(await decompressed.arrayBuffer());
  expect(raw.length).toBe((400 * 4 + 1) * 220);
  expect(raw.some((value) => value > 0 && value < 255)).toBe(true);
});

it("handles a new user's graph without dividing by zero", async () => {
  expect((await ratingChart([1500])).length).toBeGreaterThan(100);
  await expect(ratingChart([])).rejects.toThrow();
  await expect(ratingChart([Number.NaN])).rejects.toThrow();
});

it("loads an actual problem from the bundled Codeforces catalog", async () => {
  const catalog = new Catalog(env.ASSETS);
  expect((await catalog.problem("1000a")).id).toBe("1000A");
  expect((await catalog.problem("4a")).name).toBe("Watermelon");
  expect((await catalog.problem("4a")).contestStartTimeSeconds).toBe(1_268_395_200);
  expect(problemUrl("4A")).toBe("https://codeforces.com/problemset/problem/4/A?locale=en");
  const bucket = await catalog.bucket(1500);
  expect(bucket.length).toBeGreaterThan(10);
  expect(bucket.every((problem) => problem.rating === 1500)).toBe(true);
  expect(bucket.every((problem) => Number.isInteger(problem.contestStartTimeSeconds))).toBe(true);
  await expect(catalog.bucket(1550)).rejects.toThrow("steps of 100");
  await expect(catalog.problem("not-a-problem")).rejects.toThrow("not in the catalog");
});

it("keeps Russian-only problem titles out of the catalog", async () => {
  const catalog = new Catalog(env.ASSETS);
  const buckets = await Promise.all(Array.from({ length: 28 }, (_, index) => catalog.bucket(800 + index * 100)));
  expect(buckets.flat().every((problem) => !/\p{Script=Cyrillic}/u.test(problem.name))).toBe(true);
});

it("samples small suggestion pools without duplicates or mutating the source", () => {
  const original = ["a", "b", "c"];
  expect(sample(original, 10).sort()).toEqual(original);
  expect(original).toEqual(["a", "b", "c"]);
  expect(sample([], 10)).toEqual([]);
});

it("favors contests about two years old without excluding others", () => {
  const yearSeconds = 365.25 * 24 * 60 * 60;
  const ages = [0, 1, 2, 3, 5, 8];
  const problems = ages.map((age, index) => ({
    id: `${index + 1}A`, contestId: index + 1,
    contestStartTimeSeconds: Math.floor(Date.now() / 1000 - age * yearSeconds),
    index: "A", name: `Problem ${index + 1}`, rating: 1500,
  }));
  const original = problems.slice();
  const chosen = sampleRecentProblems(problems, 4);
  expect(chosen).toHaveLength(4);
  expect(new Set(chosen.map((problem) => problem.id)).size).toBe(4);
  expect(problems).toEqual(original);
  expect(sampleRecentProblems([], 10)).toEqual([]);
  expect(sampleRecentProblems(problems, 0)).toEqual([]);
  expect(sampleRecentProblems(problems.slice(0, 3), 10)).toHaveLength(3);

  const counts = Array<number>(ages.length).fill(0);
  for (let trial = 0; trial < 5000; trial++) {
    counts[sampleRecentProblems(problems, 1)[0]!.contestId - 1]!++;
  }
  expect(counts[2]).toBeGreaterThan(counts[1]!);
  expect(counts[2]).toBeGreaterThan(counts[3]!);
  expect(counts[2]).toBeGreaterThan(counts[0]! * 1.5);
  expect(counts[2]).toBeGreaterThan(counts[5]! * 20);
  expect(counts[0]).toBeGreaterThan(0);
  expect(counts[5]).toBeGreaterThan(0);
});

it("registers all original features as guild slash commands", () => {
  expect(COMMANDS.map((command) => command.name).sort()).toEqual([
    "challenge", "help", "history", "leaderboard", "ping", "rating", "register", "suggest", "unlink",
  ]);
  expect(COMMANDS.every((command) => command.contexts[0] === 0)).toBe(true);
});
