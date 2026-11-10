# ttaeng-cli

A command-line client for the Reddit Data API, run by hand by the developer of
[Ddaeng Workout Timer](https://apps.apple.com/app/id6825693169)
([Android](https://play.google.com/store/apps/details?id=dev.swyang.ttaeng)), an
interval / Tabata / round timer sold as a one-time purchase.

It exists so that the developer can post in subreddits that allow developer
self-posts, and answer the comments on those posts, while following each
subreddit's rules and Reddit's Responsible Builder Policy. This repository is a
mirror of `scripts/reddit/` in the app's private repository, published so the
source can be reviewed as part of a Reddit Data API access request.

## What it does

Three things, each started by a person at a terminal:

1. **Read before writing** — `sub <subreddit>` fetches the subreddit's basic
   info, rules, link flairs and pinned posts, so a post can follow them.
2. **Submit one approved text post** — `submit` sends a post whose title and
   body the operator has written and reviewed. `--dry-run` prints the exact
   payload without sending it.
3. **Answer comments on its own posts** — `comments` lists the comments on the
   operator's posts; `reply` and `edit` send a reply or edit the operator's own
   text, again from a file the operator reviewed.

## What it refuses to do

- **Nothing runs unattended.** There is no daemon, scheduler, cron entry or
  retry loop. Every command is a single explicit run that exits.
- **Cadence guards with no bypass flag.** `submit` refuses to post to the same
  subreddit more than once in 30 days, to post anywhere within 3 days of the
  previous post, and to post text whose word-set similarity to an earlier post
  is above 60% (`SAME_SUB_DAYS`, `ANY_SUB_DAYS`, `MAX_SIMILARITY` in
  `scripts/reddit/lib.mjs`). This is how it avoids "identical or substantially
  similar content across subreddits".
- **Reads only what it needs.** Public subreddit metadata and the comments on
  the operator's own posts. It stores nothing about other users.
- **API only.** No scraping, no browser automation; every request goes to
  `oauth.reddit.com` with a user OAuth token and a truthful User-Agent.

## How it talks to Reddit

- OAuth 2.0 authorization-code flow (`duration=permanent`), scopes
  `identity read submit edit flair`. The refresh token is kept in a local file
  with mode 600 and is never committed.
- User-Agent `macos:dev.swyang.ttaeng.reddit-cli:0.1.0 (by /u/<operator>)`.
  `auth` warns if the token's owner differs from the configured username so the
  User-Agent cannot drift from the truth.
- Endpoints: `/api/v1/me`, `/r/{sub}/about`, `/r/{sub}/about/rules`,
  `/r/{sub}/api/link_flair_v2`, `/r/{sub}/hot` (pinned posts only),
  `/api/submit`, `/comments/{id}`, `/api/comment`, `/api/editusertext`.
- Volume: well under the 100 requests/minute limit; a day on which the tool is
  used needs fewer than 50 calls, and most days it is not run at all.
- Every post and reply is appended to a JSON log (`--log`, default
  `docs/community/reddit-posts.json`). That log is the input to the cadence
  guards above, so manual posts are recorded there too.

## Setup

1. Register a **script** type app at `reddit.com/prefs/apps` with redirect URI
   `http://localhost:8765/callback`.
2. Create `~/.config/ttaeng-reddit/config.json` (mode 600):

   ```json
   { "client_id": "…", "client_secret": "…", "username": "<operator>", "port": 8765 }
   ```

   The directory can be changed with `TTAENG_REDDIT_CONFIG_DIR`.
3. Run `npm run reddit -- auth`. It prints the authorize URL, waits for the
   redirect on `127.0.0.1:8765`, exchanges the code and saves the token to
   `~/.config/ttaeng-reddit/token.json`.

## Commands

```
reddit auth
reddit me
reddit sub <subreddit> [--json]
reddit submit --sub <subreddit> --title "…" --body post.md [--flair-id …] [--dry-run] [--log file]
reddit comments <post url | id | all> [--since …]
reddit reply --to <t1_… | t3_…> --body reply.md [--dry-run]
reddit edit --thing <t3_… | t1_…> --body text.md
reddit posts
```

Run them as `npm run reddit -- <command> …` or `node scripts/reddit/reddit.mjs <command> …`.

## Tests

`npm test` runs the unit tests for the pure functions in `lib.mjs` (User-Agent
format, authorize URL, submit payload, cadence guards, response parsing). They
make no network requests.

Requires Node.js 22 or newer. No dependencies.
