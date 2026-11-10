// scripts/reddit/lib.mjs — 네트워크 없는 순수 함수. 테스트: node --test scripts/reddit/lib.test.mjs
// 규칙 출처: docs/community/reddit.md (Reddit Data API Wiki, Responsible Builder Policy, Spam)

export const APP_ID = 'dev.swyang.ttaeng.reddit-cli';
export const VERSION = '0.1.0';
export const SCOPES = ['identity', 'read', 'submit', 'edit', 'flair'];
export const SAME_SUB_DAYS = 30; // launch-posts.md §0: 같은 서브레딧 30일에 1회
export const ANY_SUB_DAYS = 3; // launch-posts.md §0: 다른 서브레딧과도 3일 간격
export const MAX_SIMILARITY = 0.6; // RBP: "identical or substantially similar content across subreddits"

const DAY_MS = 24 * 60 * 60 * 1000;
const REDDIT = 'https://www.reddit.com';

// Data API Wiki: "<platform>:<app ID>:<version string> (by /u/<reddit username>)". 절대 거짓말하지 않는다.
export function userAgent({ username, version = VERSION }) {
  if (!username) throw new Error('username is required to build the User-Agent');
  return `macos:${APP_ID}:${version} (by /u/${username})`;
}

export function buildAuthorizeUrl({ clientId, redirectUri, state, scopes = SCOPES }) {
  const url = new URL(`${REDDIT}/api/v1/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('duration', 'permanent');
  url.searchParams.set('scope', scopes.join(' '));
  return url.toString();
}

export function normalizeSub(sub) {
  return String(sub ?? '')
    .trim()
    .replace(/^\/?r\//i, '')
    .replace(/\/+$/, '');
}

export function buildSubmitForm({ sub, title, body, flairId }) {
  const t = String(title ?? '').trim();
  const b = String(body ?? '').trim();
  if (!t) throw new Error('title is empty');
  if (t.length > 300) throw new Error(`title is ${t.length} chars; Reddit allows 300`);
  if (!b) throw new Error('body is empty');
  const sr = normalizeSub(sub);
  if (!sr) throw new Error('subreddit is empty');
  const form = {
    api_type: 'json',
    kind: 'self',
    sr,
    title: t,
    text: b,
    sendreplies: 'true',
    nsfw: 'false',
    spoiler: 'false',
    validate_on_submit: 'true',
  };
  if (flairId) form.flair_id = flairId;
  return form;
}

function words(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

export function wordJaccard(a, b) {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  return inter / (wa.size + wb.size - inter);
}

// 게시 전 빈도·유사도 점검. log는 docs/community/reddit-posts.json의 배열.
export function checkCadence({
  log,
  sub,
  body,
  now = Date.now(),
  sameSubDays = SAME_SUB_DAYS,
  anyDays = ANY_SUB_DAYS,
  maxSimilarity = MAX_SIMILARITY,
}) {
  const target = normalizeSub(sub).toLowerCase();
  const reasons = [];
  for (const entry of log ?? []) {
    if ((entry.type ?? 'post') !== 'post' || !entry.postedAt) continue;
    const ageDays = (now - Date.parse(entry.postedAt)) / DAY_MS;
    const age = `${ageDays.toFixed(1)} days ago`;
    if (normalizeSub(entry.sub).toLowerCase() === target && ageDays < sameSubDays) {
      reasons.push(
        `r/${normalizeSub(entry.sub)} already got a post ${age} (${entry.url}); minimum ${sameSubDays} days per subreddit`,
      );
    }
    if (ageDays < anyDays) {
      reasons.push(`last post was ${age} (${entry.url}); minimum ${anyDays} days between posts`);
    }
    const similarity = wordJaccard(entry.body, body);
    if (similarity >= maxSimilarity) {
      reasons.push(
        `body is ${Math.round(similarity * 100)}% similar to ${entry.url}; Reddit forbids "identical or substantially similar content across subreddits"`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function unwrapJson(res, what) {
  const j = res?.json;
  if (!j) throw new Error(`unexpected ${what} response: ${JSON.stringify(res).slice(0, 300)}`);
  if (Array.isArray(j.errors) && j.errors.length > 0) {
    throw new Error(`Reddit rejected the ${what}: ${j.errors.map((e) => e.join(': ')).join('; ')}`);
  }
  return j.data ?? {};
}

export function parseSubmitResponse(res) {
  const d = unwrapJson(res, 'submit');
  return { url: d.url, id: d.id, name: d.name };
}

export function parseCommentResponse(res) {
  const d = unwrapJson(res, 'comment');
  const thing = d.things?.[0]?.data;
  if (!thing?.name)
    throw new Error(`comment response has no thing: ${JSON.stringify(d).slice(0, 300)}`);
  return { name: thing.name, permalink: `${REDDIT}${thing.permalink}` };
}

export function postIdFrom(ref) {
  const s = String(ref ?? '').trim();
  const m = s.match(/\/comments\/([a-z0-9]+)/i);
  if (m) return m[1];
  return s.replace(/^t3_/, '');
}

// GET /comments/{id} 응답([글 listing, 댓글 listing])을 깊이 우선으로 평탄화. "more" 스텁은 건너뛴다.
export function flattenComments(tree) {
  const out = [];
  const walk = (listing, depth) => {
    for (const child of listing?.data?.children ?? []) {
      if (child.kind !== 't1') continue;
      const d = child.data;
      out.push({
        name: d.name,
        author: d.author,
        body: d.body,
        createdUtc: d.created_utc,
        permalink: `${REDDIT}${d.permalink}`,
        depth,
      });
      if (d.replies && typeof d.replies === 'object') walk(d.replies, depth + 1);
    }
  };
  walk(tree?.[1], 0);
  return out;
}
