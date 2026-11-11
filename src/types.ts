export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  JOBS: Queue<QueuedJob>;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
}

export interface BackgroundJob {
  kind: "registration" | "participant" | "account" | "expire" | "publish_challenge" | "publish_registration";
  id: string;
  userId?: string;
}

export interface QueuedJob extends BackgroundJob {
  queueOwner: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser; nick?: string | null };
  user?: DiscordUser;
  data?: {
    name?: string;
    custom_id?: string;
    options?: { name: string; value: string | number | boolean }[];
    resolved?: { users?: Record<string, DiscordUser> };
  };
  message?: { id: string };
}

export interface Embed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  image?: { url: string };
}

export interface Button {
  type: 2;
  style: number;
  label: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

export interface Message {
  content?: string;
  embeds?: Embed[];
  components?: { type: 1; components: Button[] }[];
  flags?: number;
  allowed_mentions?: { parse: string[] };
  attachments?: { id: number; filename: string; description?: string }[];
  nonce?: string;
  enforce_nonce?: boolean;
}

export interface Problem {
  id: string;
  contestId: number;
  index: string;
  name: string;
  rating: number;
}

export interface UserRow {
  guild_id: string;
  user_id: string;
  handle: string;
  rating: number;
  registration_id: string;
  created_at: number;
}

export interface Challenge {
  id: string;
  guild_id: string;
  creator_id: string;
  channel_id: string;
  message_id: string | null;
  problem_id: string;
  problem_name: string;
  problem_rating: number;
  minutes: number;
  status: "waiting" | "active" | "complete" | "cancelled";
  confirm_until: number;
  starts_at: number | null;
  ends_at: number | null;
  created_at: number;
  version: number;
  dirty: number;
}

export type Outcome = "pending" | "solved" | "failed" | "gave_up" | "void";

export interface Participant {
  challenge_id: string;
  user_id: string;
  handle: string;
  rating_start: number;
  ready: number;
  outcome: Outcome;
  resolution_id: string | null;
  next_poll: number;
  scan_from: number;
  saw_testing: number;
  last_error: string | null;
  can_void: number;
}

export interface Registration {
  id: string;
  guild_id: string;
  user_id: string;
  handle: string;
  channel_id: string;
  message_id: string | null;
  problem_id: string;
  created_at: number;
  submit_until: number;
  next_poll: number;
  status: "pending" | "verified" | "failed" | "expired";
  detail: string | null;
  dirty: number;
}

export interface Account {
  handle: string;
  cursor: number;
  latest_id: number;
  new_latest_id: number;
  stop_id: number;
  next_sync: number | null;
  synced_at: number | null;
  scanned: number;
  last_error: string | null;
}

export interface Submission {
  id: number;
  creationTimeSeconds: number;
  verdict?: string;
  contestId?: number;
  problem: { contestId?: number; index: string };
}

export class UserError extends Error {}

export function actor(interaction: Interaction): DiscordUser {
  const user = interaction.member?.user ?? interaction.user;
  if (!user) throw new UserError("Discord did not provide a user for this command.");
  return user;
}

export function option(interaction: Interaction, name: string): string | number | boolean | undefined {
  return interaction.data?.options?.find((item) => item.name === name)?.value;
}

export function problemParts(id: string): { contestId: number; index: string } {
  const match = /^(\d{1,7})([A-Z][A-Z0-9]*)$/.exec(id);
  if (!match) throw new UserError("Use a Codeforces problem ID such as 1000A.");
  return { contestId: Number(match[1]), index: match[2]! };
}

export function problemUrl(id: string): string {
  const { contestId, index } = problemParts(id);
  return `https://codeforces.com/problemset/problem/${contestId}/${index}`;
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_`~|[\]<>])/g, "\\$1");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}
