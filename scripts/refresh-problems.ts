import { mkdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import type { Problem } from "../src/types.ts";

interface CFProblem {
  contestId?: number;
  index: string;
  name: string;
  rating?: number;
  tags: string[];
}

const directory = fileURLToPath(new URL("../public/problems/", import.meta.url));
const response = await fetch("https://codeforces.com/api/problemset.problems", {
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Codeforces returned HTTP ${response.status}; existing catalog was kept.`);
const data = await response.json() as { status: string; result?: { problems: CFProblem[] } };
if (data.status !== "OK" || !Array.isArray(data.result?.problems)) {
  throw new Error("Codeforces returned an invalid problem set; existing catalog was kept.");
}
const buckets: Record<string, Problem[]> = {};
for (let rating = 800; rating <= 3500; rating += 100) buckets[rating] = [];
const index: Record<string, number> = {};
for (const problem of data.result.problems) {
  if (!problem.contestId || !problem.rating || !buckets[problem.rating] || problem.tags.includes("*special")) continue;
  const id = `${problem.contestId}${problem.index}`;
  buckets[problem.rating]!.push({
    id, contestId: problem.contestId, index: problem.index, name: problem.name, rating: problem.rating,
  });
  index[id] = problem.rating;
}
if (Object.keys(index).length < 1000) throw new Error("Problem set was unexpectedly small; existing catalog was kept.");
await mkdir(directory, { recursive: true });
for (const [rating, problems] of Object.entries(buckets)) {
  const path = `${directory}${rating}.json`;
  await writeFile(`${path}.tmp`, JSON.stringify(problems) + "\n");
  await rename(`${path}.tmp`, path);
}
const manifest = {
  updatedAt: new Date().toISOString(),
  ratings: Object.fromEntries(Object.entries(buckets).map(([rating, problems]) => [rating, problems.length])),
  index,
};
await writeFile(`${directory}manifest.json.tmp`, JSON.stringify(manifest) + "\n");
await rename(`${directory}manifest.json.tmp`, `${directory}manifest.json`);
console.log(`Updated ${Object.keys(index).length} rated problems in ${Object.keys(buckets).length} buckets.`);
