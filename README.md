# ArugoBot

Codeforces challenges for Discord, running on **Cloudflare Workers** instead of
an always-connected Python process. Your computer can be turned off.

This is a TypeScript fork of [eggag32/ArugoBot](https://github.com/eggag32/ArugoBot).
It keeps the original rating formula and core commands, using slash commands,
buttons, a persistent D1 database, and short scheduled jobs.

## Commands

| Command | What it does |
| --- | --- |
| `/register handle` | Verify ownership of your Codeforces handle with a compilation-error submission |
| `/challenge problem minutes [opponent1 … opponent4]` | Challenge yourself and up to four friends; use a problem ID like `1000A` or a rating like `1500` |
| `/suggest rating [opponent1 … opponent4]` | Suggest up to ten problems none of the participants have solved |
| `/rating [user]` | Display a PNG rating graph |
| `/history [user] [page]` | Browse challenges and rating changes |
| `/leaderboard [page]` | View this server's rankings |
| `/unlink` | Confirm removal of your handle, rating, and history in this server |
| `/ping`, `/help` | Check the bot and show help |

New users start at **1500**. Challenges last **40, 60, 80, 100, or 120 minutes**.
Everyone has 30 seconds to confirm with the **Ready** button. Players can give
up, check their result, or cancel without a rating change during a verified
Codeforces outage.

Results normally update within about a minute, plus queue/network delay. The
actual Codeforces submission timestamp determines whether a solve was on time.
Pending judgements get up to five minutes of grace; a result that cannot be
verified is voided rather than treated as a loss.

## Deploy

You need Node.js **24+**, a Cloudflare account, and a Discord application named
**ArugoBot**. Keep the Cloudflare account on the **Workers Free** plan for a $0
deployment within the free limits described below.

1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create an application named **ArugoBot**. From **General Information**, get
   its Application ID and Public Key. From **Bot**, generate its **bot token**.
   Message Content Intent is not required.
2. Clone this fork and install its development tools:

   ```bash
   git clone https://github.com/jma02/ArugoBot.git
   cd ArugoBot
   npm ci
   npm run setup
   ```

3. The setup command opens Cloudflare's login, creates/reuses the D1 database,
   creates the job queue, applies the schema, deploys the Worker, stores the
   Discord credentials as Cloudflare secrets, and registers the slash commands.
   The bot token is entered at a hidden prompt; it is not saved in the repository.
4. Copy the printed **Interactions Endpoint URL** into your Discord application's
   **General Information → Interactions Endpoint URL**, and save it.
5. Use the printed invite link to add ArugoBot to your server. Check its channel
   permissions: **View Channels, Send Messages, Embed Links, Attach Files**.
   Add **Send Messages in Threads** if you will use it in threads.
6. Run `/ping`, `/help`, and `/register` in your server. Global command changes
   can take a little time to appear.

The bot can appear **offline in the member list** because it does not maintain
a Discord Gateway connection. Its slash commands and buttons still work.

If your Cloudflare login has access to multiple accounts, set
`CLOUDFLARE_ACCOUNT_ID` to the intended account before running setup. The setup
updates the public D1 database identifier in `wrangler.jsonc`; it does not store
your bot token or Cloudflare OAuth token there.

### Manual deployment

For existing Cloudflare projects, the equivalent steps are:

```bash
npx wrangler login
npx wrangler d1 create arugobot --update-config=false
```

Put the returned database ID into the `DB` binding in `wrangler.jsonc`, then:

```bash
npx wrangler queues create arugobot-jobs
npm run db:remote
npm run deploy
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

To register commands, copy `.dev.vars.example` to `.dev.vars`, fill in the
Discord values locally, and run:

```bash
npm run register:commands
```

Set `DISCORD_GUILD_ID` in that file to register in one test server instead of
globally. The script replaces this application's commands in the selected scope.
Use a separate Discord application for development if you already run ArugoBot
in production.

## How it runs without an always-on bot

```text
Discord /command or button
          │
          ▼
    Signed HTTP request ──► Worker ──► D1 state + Discord response
                                      ▲
One-minute scheduled trigger ──► Queue ┘
                                │
                                └─► Codeforces check ──► Discord message update
```

- HTTP interactions are signature-checked and acknowledged before Codeforces
  work starts, within Discord's three-second acknowledgement window.
- Challenge confirmations, deadlines, pagination cursors, pending verifications,
  and ratings are saved in D1. They do not depend on an open request or timer.
- Cron finds due work; Queues gives each check its own short invocation.
  A single queue consumer and a shared API budget space Codeforces requests at
  least 2.1 seconds apart.
- Database transactions prevent duplicate ratings from simultaneous clicks,
  repeated HTTP requests, or queue redelivery.
- Long-lived challenge messages use the bot's REST API credentials. They do not
  depend on interaction tokens, which expire after 15 minutes.
- Rating graphs are rendered as small PNGs without native graphics libraries
  or an external chart service.

Initial Codeforces history imports run in pages of 200 submissions. A large
account may need a few minutes before suggestions and challenges are ready.
Incremental refreshes reuse that history and revisit submissions still being
judged. No proxy service is required.

### Free-plan limits

This configuration uses services available on the Workers Free plan:

| Resource | Current free allowance |
| --- | --- |
| Workers | 100,000 requests/day; 10 ms CPU per invocation |
| D1 | 5 million rows read/day; 100,000 rows written/day; 5 GB total storage |
| Queues | 10,000 operations/day; usually three operations per delivered job |
| Static assets | Bundled problem catalog, served separately from Worker compute |

A two-hour challenge with five players uses roughly 600 periodic result checks,
or about 1,800 queue operations before retries, verification, and history imports.
Idle scheduled checks do not enqueue jobs.

These are account-wide limits, not a guarantee of unlimited free hosting.
Busy servers, very large histories, frequent graph generation, and API failures
can increase usage. On the Free plan, exhausted quotas interrupt work; watch
Cloudflare's usage and CPU metrics before relying on it for competitions. Do
not enable a paid plan unless you intend to accept usage charges.

The implementation keeps the large Codeforces problem-set download out of Worker
invocations, bounds history pages, limits queued batches to one job, and retains
unfinished work in D1 for recovery. Local tests do not establish production CPU
usage or connectivity from Cloudflare to Codeforces.

References: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/).

## Refreshing the problem catalog

The checked-in catalog contains rated, non-special Codeforces problems, split
into small files by rating. To fetch new problems:

```bash
npm run refresh:problems
npm run deploy
```

The **Refresh Codeforces problems** GitHub workflow refreshes the catalog daily
and commits changes to the fork. Enable Actions on your fork if GitHub has
disabled inherited workflows. Without deployment credentials, the workflow
updates the repository only. To deploy updates automatically, add repository
secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` with the Worker deployment,
D1, Queues, and account-read permissions needed by Wrangler. The Discord bot
token stays in Cloudflare.

## Development and verification

```bash
npm ci
npm run db:local
cp .dev.vars.example .dev.vars
# Fill in the local Discord values when testing with a real Discord application.
npm run dev
```

Local development uses local D1 and queue bindings. Discord needs a public HTTPS
Interactions Endpoint; use a separate development deployment/application when
testing commands through Discord. An unsigned curl request to `/interactions`
must return `401`.

```bash
npm run typecheck
npm test
npm run build
```

Tests run in Cloudflare's local Workers runtime with real D1/SQLite behavior and
mocked outbound APIs. They cover signature verification, replay rejection,
acknowledgements, duplicate deliveries, account ownership, rating races,
deadlines, pending judgements, Codeforces pagination/rate limits, queue recovery,
server isolation, and PNG output. GitHub Actions runs the same checks.

### Operations

```bash
npx wrangler tail
npx wrangler d1 export DB --remote --output arugobot-backup.sql
```

Keep database backups private: they contain Discord IDs and Codeforces handles.
To update the application, apply pending migrations with `npm run db:remote`,
then run `npm run deploy`. Queued and active challenges are stored outside the
Worker and survive routine code deployments.

If `/ping` works but Codeforces operations fail, inspect the Worker logs. A
Codeforces outage, rate limit, or restriction on the hosting provider's IPs
needs to be resolved independently of the Discord connection.

If commands never appear, check command registration, the chosen global/test
server scope, the bot installation, and channel permissions. If commands time
out immediately, verify the endpoint URL and Discord Public Key. A deleted
challenge message is not recreated automatically; its existing participants'
results can still be recorded and viewed with `/history`.

## Compatibility and attribution

- Prefix commands and reaction controls are replaced with slash commands and buttons.
- Rating graphs show the most recent 200 challenges; `/history` retains the full history.
- There are no background chat readers, Gateway presence updates, or member-list caches.
- This version starts with a new D1 database. Existing Python SQLite data is not
  imported automatically.
- The original Python implementation and its deployment notes are preserved in
  [`legacy/python`](legacy/python/).

Original ArugoBot: **eggag32**. Original Arugo idea: **phattd15 / polarity-ac**.
Distributed under the original [MIT license](LICENSE).
