#!/usr/bin/env node
// scripts/reddit/reddit.mjs — 땡 레딧 게시 도구. 공식 Data API + OAuth만 쓴다(스크래핑·브라우저 자동화 없음).
// 사용법·정책 전제: docs/community/reddit-cli.md. 순수 로직은 lib.mjs, 테스트는 lib.test.mjs.
//
//   node scripts/reddit/reddit.mjs auth                      # 1회: 브라우저에서 허용 → refresh token 저장
//   node scripts/reddit/reddit.mjs me
//   node scripts/reddit/reddit.mjs sub iOSProgramming        # 규칙·플레어·기본 정보(API로 읽음)
//   node scripts/reddit/reddit.mjs submit --sub iOSProgramming --title "…" --body post.md [--flair-id …] [--dry-run]
//   node scripts/reddit/reddit.mjs comments <url|id|all>
//   node scripts/reddit/reddit.mjs reply --to t1_xxx --body reply.md [--dry-run]
//   node scripts/reddit/reddit.mjs edit --thing t3_xxx --body post.md
//   node scripts/reddit/reddit.mjs posts
//
// 무인 실행(cron) 금지: 글·댓글은 운영자가 채팅에서 승인한 것만 올린다(RBP의 App 계정·스팸 조항).

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  buildAuthorizeUrl,
  buildSubmitForm,
  checkCadence,
  flattenComments,
  normalizeSub,
  parseCommentResponse,
  parseSubmitResponse,
  postIdFrom,
  userAgent,
} from './lib.mjs';

const CONFIG_DIR =
  process.env.TTAENG_REDDIT_CONFIG_DIR ?? path.join(homedir(), '.config', 'ttaeng-reddit');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_LOG_PATH = path.join(REPO_ROOT, 'docs', 'community', 'reddit-posts.json');
const WWW = 'https://www.reddit.com';
const API = 'https://oauth.reddit.com';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    sub: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
    'flair-id': { type: 'string' },
    to: { type: 'string' },
    thing: { type: 'string' },
    since: { type: 'string' },
    log: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
});
const [command, ...args] = positionals;
const LOG_PATH = opts.log ? path.resolve(opts.log) : DEFAULT_LOG_PATH;

// ---------- config / token ----------

async function loadConfig() {
  let raw;
  try {
    raw = await readFile(CONFIG_PATH, 'utf8');
  } catch {
    throw new Error(
      `no config at ${CONFIG_PATH}\n` +
        'create it with: {"client_id":"…","client_secret":"…","username":"<your reddit username>","port":8765}',
    );
  }
  const cfg = JSON.parse(raw);
  for (const key of ['client_id', 'client_secret', 'username']) {
    if (!cfg[key]) throw new Error(`config.json is missing "${key}"`);
  }
  cfg.port = Number(cfg.port ?? 8765);
  cfg.redirect_uri = `http://localhost:${cfg.port}/callback`;
  return cfg;
}

async function loadToken() {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function saveToken(token) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_PATH, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

async function tokenRequest(cfg, params) {
  const res = await fetch(`${WWW}/api/v1/access_token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.client_id}:${cfg.client_secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent({ username: cfg.username }),
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`token endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.error) {
    throw new Error(`token endpoint error ${res.status}: ${json.error ?? text.slice(0, 200)}`);
  }
  return json;
}

async function refreshToken(cfg, token) {
  const fresh = await tokenRequest(cfg, {
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });
  const next = {
    ...token,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token ?? token.refresh_token,
    scope: fresh.scope ?? token.scope,
    expires_at: Date.now() + fresh.expires_in * 1000,
  };
  await saveToken(next);
  return next;
}

async function accessToken(cfg, { force = false } = {}) {
  let token = await loadToken();
  if (!token?.refresh_token) throw new Error(`no token at ${TOKEN_PATH}; run: reddit auth`);
  if (force || !token.expires_at || token.expires_at - 60_000 < Date.now()) {
    token = await refreshToken(cfg, token);
  }
  return token.access_token;
}

// ---------- API ----------

async function api(cfg, method, pathname, { query, form, retry = true } = {}) {
  const token = await accessToken(cfg);
  const url = new URL(API + pathname);
  url.searchParams.set('raw_json', '1');
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  const headers = {
    Authorization: `bearer ${token}`,
    'User-Agent': userAgent({ username: cfg.username }),
  };
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(url, {
    method,
    headers,
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  if (res.status === 401 && retry) {
    await accessToken(cfg, { force: true });
    return api(cfg, method, pathname, { query, form, retry: false });
  }
  if (opts.verbose) {
    console.error(
      `[${method} ${pathname}] ${res.status} ratelimit remaining=${res.headers.get('x-ratelimit-remaining')} reset=${res.headers.get('x-ratelimit-reset')}s`,
    );
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${method} ${pathname} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

// ---------- log ----------

async function loadLog() {
  try {
    return JSON.parse(await readFile(LOG_PATH, 'utf8'));
  } catch {
    return [];
  }
}

async function appendLog(entry) {
  const log = await loadLog();
  log.push(entry);
  await writeFile(LOG_PATH, `${JSON.stringify(log, null, 2)}\n`);
}

async function readBodyFile(file, what = '--body') {
  if (!file) throw new Error(`${what} <file> is required`);
  const text = await readFile(path.resolve(file), 'utf8');
  if (!text.trim()) throw new Error(`${file} is empty`);
  return text.trim();
}

// ---------- commands ----------

function waitForCode(port, expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const { code, state, error } = Object.fromEntries(url.searchParams);
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Reddit returned: ${error}`);
        finish(new Error(`authorization failed: ${error}`));
        return;
      }
      if (state !== expectedState || !code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('state mismatch — start over');
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<p>Authorized. You can close this tab and go back to the terminal.</p>');
      finish(null, code);
    });
    const timer = setTimeout(
      () => finish(new Error('timed out waiting for the callback')),
      AUTH_TIMEOUT_MS,
    );
    function finish(err, code) {
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(code);
    }
    server.on('error', (err) => finish(err));
    server.listen(port, '127.0.0.1');
  });
}

async function cmdAuth() {
  const cfg = await loadConfig();
  const state = randomBytes(16).toString('hex');
  const url = buildAuthorizeUrl({
    clientId: cfg.client_id,
    redirectUri: cfg.redirect_uri,
    state,
  });
  console.log(
    `1) Open this URL in a browser where you are logged in as u/${cfg.username}:\n\n${url}\n`,
  );
  console.log(`2) Click Allow. Waiting for Reddit to call ${cfg.redirect_uri} (up to 5 minutes)…`);
  const code = await waitForCode(cfg.port, state);
  const tok = await tokenRequest(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirect_uri,
  });
  if (!tok.refresh_token)
    throw new Error('Reddit returned no refresh_token (duration=permanent missing?)');
  await saveToken({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    scope: tok.scope,
    expires_at: Date.now() + tok.expires_in * 1000,
  });
  const me = await api(cfg, 'GET', '/api/v1/me');
  if (me.name.toLowerCase() !== cfg.username.toLowerCase()) {
    console.warn(
      `warning: the token belongs to u/${me.name} but config.json says u/${cfg.username}. Fix config.json so the User-Agent stays truthful.`,
    );
  }
  console.log(`Authorized as u/${me.name}. Scopes: ${tok.scope}. Token saved to ${TOKEN_PATH}`);
}

async function cmdMe() {
  const cfg = await loadConfig();
  const me = await api(cfg, 'GET', '/api/v1/me');
  if (opts.json) return console.log(JSON.stringify(me, null, 2));
  console.log(
    `u/${me.name} · karma ${me.total_karma ?? me.link_karma + me.comment_karma} · created ${new Date(me.created_utc * 1000).toISOString().slice(0, 10)}`,
  );
}

async function cmdSub() {
  const name = normalizeSub(args[0] ?? opts.sub);
  if (!name) throw new Error('usage: sub <subreddit>');
  const cfg = await loadConfig();
  const about = (await api(cfg, 'GET', `/r/${name}/about`)).data;
  const rules = await api(cfg, 'GET', `/r/${name}/about/rules`);
  let flairs = [];
  let flairNote = '';
  try {
    flairs = await api(cfg, 'GET', `/r/${name}/api/link_flair_v2`);
  } catch (err) {
    flairNote = `(link flairs unavailable: ${err.message.split('\n')[0]})`;
  }
  const hot = await api(cfg, 'GET', `/r/${name}/hot`, { query: { limit: 10 } });
  const pinned = (hot.data?.children ?? []).filter((c) => c.data.stickied).map((c) => c.data);
  if (opts.json) return console.log(JSON.stringify({ about, rules, flairs, pinned }, null, 2));
  console.log(`# r/${about.display_name}`);
  console.log(
    `subscribers ${about.subscribers} · active ${about.active_user_count ?? '?'} · posts: ${about.submission_type} · nsfw: ${about.over18}`,
  );
  if (about.public_description) console.log(`\n${about.public_description.trim()}`);
  console.log('\n## Rules');
  for (const [i, r] of (rules.rules ?? []).entries()) {
    console.log(`${i + 1}. [${r.kind}] ${r.short_name}`);
    if (r.description?.trim()) console.log(`   ${r.description.trim().replace(/\n+/g, '\n   ')}`);
  }
  console.log(`\n## Link flairs ${flairNote}`);
  for (const f of flairs) console.log(`- ${f.text || '(no text)'} · id ${f.id}`);
  console.log('\n## Pinned posts');
  for (const p of pinned) console.log(`- ${p.title}\n  ${WWW}${p.permalink}`);
}

async function cmdSubmit() {
  const body = await readBodyFile(opts.body);
  const form = buildSubmitForm({
    sub: opts.sub,
    title: opts.title,
    body,
    flairId: opts['flair-id'],
  });
  const log = await loadLog();
  const guard = checkCadence({ log, sub: form.sr, body });
  if (!guard.ok) {
    console.error('refusing to post:');
    for (const r of guard.reasons) console.error(`- ${r}`);
    process.exit(2);
  }
  if (opts['dry-run']) {
    console.log(`[dry-run] would POST /api/submit to r/${form.sr}`);
    console.log(`title (${form.title.length} chars): ${form.title}`);
    if (form.flair_id) console.log(`flair_id: ${form.flair_id}`);
    console.log(`body (${form.text.length} chars):\n---\n${form.text}\n---`);
    console.log(`cadence guard: ok (log ${LOG_PATH}, ${log.length} entries)`);
    return;
  }
  const cfg = await loadConfig();
  const res = await api(cfg, 'POST', '/api/submit', { form });
  const posted = parseSubmitResponse(res);
  await appendLog({
    type: 'post',
    sub: form.sr,
    title: form.title,
    body: form.text,
    flairId: form.flair_id ?? null,
    url: posted.url,
    name: posted.name,
    id: posted.id,
    postedAt: new Date().toISOString(),
  });
  console.log(`posted: ${posted.url}`);
}

function printComments(cfg, list, header) {
  console.log(`\n## ${header} — ${list.length} comments`);
  for (const c of list) {
    const who =
      c.author?.toLowerCase() === cfg.username.toLowerCase()
        ? `u/${c.author} (you)`
        : `u/${c.author}`;
    const when = new Date(c.createdUtc * 1000).toISOString().replace('T', ' ').slice(0, 16);
    console.log(
      `\n${'  '.repeat(c.depth)}- ${who} · ${when} · ${c.name}\n${'  '.repeat(c.depth)}  ${c.permalink}`,
    );
    console.log(`${'  '.repeat(c.depth)}  ${c.body.replace(/\n/g, `\n${'  '.repeat(c.depth)}  `)}`);
  }
}

async function cmdComments() {
  const ref = args[0];
  if (!ref) throw new Error('usage: comments <post url | id | all>');
  const cfg = await loadConfig();
  const since = opts.since ? Date.parse(opts.since) / 1000 : 0;
  const targets =
    ref === 'all'
      ? (await loadLog()).filter((e) => e.type === 'post').map((e) => ({ id: e.id, label: e.url }))
      : [{ id: postIdFrom(ref), label: ref }];
  for (const t of targets) {
    const tree = await api(cfg, 'GET', `/comments/${t.id}`, {
      query: { sort: 'new', limit: 200, depth: 10 },
    });
    const list = flattenComments(tree).filter((c) => c.createdUtc >= since);
    if (opts.json) console.log(JSON.stringify(list, null, 2));
    else printComments(cfg, list, t.label);
  }
}

async function cmdReply() {
  const parent = opts.to;
  if (!/^t[13]_[a-z0-9]+$/i.test(parent ?? ''))
    throw new Error('--to must be a t3_ (post) or t1_ (comment) id');
  const text = await readBodyFile(opts.body);
  if (opts['dry-run']) {
    console.log(`[dry-run] would reply to ${parent} with:\n---\n${text}\n---`);
    return;
  }
  const cfg = await loadConfig();
  const res = await api(cfg, 'POST', '/api/comment', {
    form: { api_type: 'json', thing_id: parent, text },
  });
  const posted = parseCommentResponse(res);
  await appendLog({
    type: 'comment',
    parent,
    body: text,
    name: posted.name,
    url: posted.permalink,
    postedAt: new Date().toISOString(),
  });
  console.log(`replied: ${posted.permalink}`);
}

async function cmdEdit() {
  const thing = opts.thing;
  if (!/^t[13]_[a-z0-9]+$/i.test(thing ?? '')) throw new Error('--thing must be a t3_ or t1_ id');
  const text = await readBodyFile(opts.body);
  const cfg = await loadConfig();
  const res = await api(cfg, 'POST', '/api/editusertext', {
    form: { api_type: 'json', thing_id: thing, text },
  });
  if (res?.json?.errors?.length)
    throw new Error(`edit rejected: ${JSON.stringify(res.json.errors)}`);
  console.log(`edited ${thing}`);
}

async function cmdPosts() {
  const log = await loadLog();
  if (opts.json) return console.log(JSON.stringify(log, null, 2));
  if (log.length === 0) return console.log(`no entries in ${LOG_PATH}`);
  for (const e of log) {
    console.log(
      `${e.postedAt.slice(0, 10)} ${e.type.padEnd(7)} ${e.type === 'post' ? `r/${e.sub} · ${e.title}` : `→ ${e.parent}`}\n  ${e.url}`,
    );
  }
}

const COMMANDS = {
  auth: cmdAuth,
  me: cmdMe,
  sub: cmdSub,
  submit: cmdSubmit,
  comments: cmdComments,
  reply: cmdReply,
  edit: cmdEdit,
  posts: cmdPosts,
};

const run = COMMANDS[command];
if (!run) {
  console.error(
    `usage: reddit <${Object.keys(COMMANDS).join('|')}> [options]  (see docs/community/reddit-cli.md)`,
  );
  process.exit(1);
}
run().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
