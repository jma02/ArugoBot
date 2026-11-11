import { UserError, type Env, type Problem } from "./types";

interface Manifest {
  updatedAt: string;
  ratings: Record<string, number>;
  index: Record<string, number>;
}

// The full Codeforces problem set is processed at build time, not inside a
// 10 ms Free Worker invocation. Each request reads only the needed rating bucket.
export class Catalog {
  constructor(private assets: Env["ASSETS"]) {}

  private async json<T>(path: string): Promise<T> {
    const response = await this.assets.fetch(new Request(`https://arugobot.invalid/problems/${path}`));
    if (!response.ok) throw new UserError("The problem catalog is unavailable. Please try again later.");
    return response.json<T>();
  }

  async bucket(rating: number): Promise<Problem[]> {
    if (!Number.isInteger(rating) || rating < 800 || rating > 3500 || rating % 100 !== 0) {
      throw new UserError("Choose a rating from 800 to 3500 in steps of 100.");
    }
    return this.json<Problem[]>(`${rating}.json`);
  }

  async problem(id: string): Promise<Problem> {
    const normalized = id.trim().toUpperCase();
    const manifest = await this.json<Manifest>("manifest.json");
    const rating = manifest.index[normalized];
    if (!rating) throw new UserError("That rated problem is not in the catalog. Try a Codeforces ID such as 1000A.");
    const problem = (await this.bucket(rating)).find((entry) => entry.id === normalized);
    if (!problem) throw new UserError("That problem is unavailable. Please choose another.");
    return problem;
  }

  async verificationProblem(): Promise<Problem> {
    const problems = await this.bucket(800);
    const problem = problems[randomIndex(problems.length)];
    if (!problem) throw new UserError("No verification problem is available.");
    return problem;
  }
}

export function randomIndex(length: number): number {
  if (length < 1) return 0;
  const values = new Uint32Array(1);
  // Rejection sampling avoids modulo bias.
  const ceiling = Math.floor(0x1_0000_0000 / length) * length;
  do { crypto.getRandomValues(values); } while (values[0]! >= ceiling);
  return values[0]! % length;
}

export function sample<T>(values: T[], count: number): T[] {
  const pool = values.slice();
  const chosen: T[] = [];
  while (chosen.length < count && pool.length) {
    chosen.push(pool.splice(randomIndex(pool.length), 1)[0]!);
  }
  return chosen;
}
