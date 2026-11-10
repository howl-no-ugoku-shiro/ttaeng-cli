// 순수 함수 테스트 — node --test scripts/reddit/lib.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAuthorizeUrl,
  buildSubmitForm,
  checkCadence,
  normalizeSub,
  parseSubmitResponse,
  postIdFrom,
  userAgent,
  wordJaccard,
} from './lib.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-07T10:00:00Z');
const entry = (sub, daysAgo, body = 'unique body ' + sub + ' ' + daysAgo) => ({
  type: 'post',
  sub,
  title: 't',
  body,
  url: 'https://www.reddit.com/r/' + sub + '/comments/abc/t/',
  postedAt: new Date(NOW - daysAgo * DAY).toISOString(),
});

test('userAgent follows Reddit format <platform>:<app ID>:<version> (by /u/<user>)', () => {
  assert.equal(
    userAgent({ username: 'someone', version: '0.1.0' }),
    'macos:dev.swyang.ttaeng.reddit-cli:0.1.0 (by /u/someone)',
  );
});

test('buildAuthorizeUrl carries client id, state, redirect, permanent duration and scopes', () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: 'http://localhost:8765/callback',
      state: 'xyz',
      scopes: ['identity', 'submit'],
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://www.reddit.com/api/v1/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'xyz');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8765/callback');
  assert.equal(url.searchParams.get('duration'), 'permanent');
  assert.equal(url.searchParams.get('scope'), 'identity submit');
});

test('normalizeSub strips r/ prefixes and slashes', () => {
  assert.equal(normalizeSub('r/iosapps'), 'iosapps');
  assert.equal(normalizeSub('/r/iOSProgramming/'), 'iOSProgramming');
  assert.equal(normalizeSub('SideProject'), 'SideProject');
});

test('buildSubmitForm produces a self post with json api_type and no flair when absent', () => {
  const form = buildSubmitForm({ sub: 'r/iosapps', title: 'Hello', body: 'Body text' });
  assert.deepEqual(form, {
    api_type: 'json',
    kind: 'self',
    sr: 'iosapps',
    title: 'Hello',
    text: 'Body text',
    sendreplies: 'true',
    nsfw: 'false',
    spoiler: 'false',
    validate_on_submit: 'true',
  });
});

test('buildSubmitForm includes flair_id when given and rejects empty or overlong input', () => {
  const form = buildSubmitForm({ sub: 'x', title: 'T', body: 'B', flairId: 'f-1' });
  assert.equal(form.flair_id, 'f-1');
  assert.throws(() => buildSubmitForm({ sub: 'x', title: '', body: 'B' }), /title/);
  assert.throws(() => buildSubmitForm({ sub: 'x', title: 'T', body: '  ' }), /body/);
  assert.throws(() => buildSubmitForm({ sub: 'x', title: 'a'.repeat(301), body: 'B' }), /300/);
});

test('wordJaccard measures word-set overlap', () => {
  assert.equal(wordJaccard('a b c', 'a b c'), 1);
  assert.equal(wordJaccard('a b c', 'd e f'), 0);
  assert.equal(wordJaccard('a b c d', 'c d e f'), 2 / 6);
  assert.equal(wordJaccard('Hello, world!', 'hello WORLD'), 1);
});

test('checkCadence allows a first post', () => {
  assert.deepEqual(checkCadence({ log: [], sub: 'iosapps', body: 'x', now: NOW }), {
    ok: true,
    reasons: [],
  });
});

test('checkCadence blocks the same subreddit within 30 days', () => {
  const r = checkCadence({ log: [entry('iosapps', 10)], sub: 'r/iosapps', body: 'new', now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /30/);
});

test('checkCadence blocks any post within 3 days of the last one', () => {
  const r = checkCadence({ log: [entry('other', 2)], sub: 'iosapps', body: 'new', now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /3/);
});

test('checkCadence allows a different sub after 3 days with different text', () => {
  const r = checkCadence({ log: [entry('other', 5)], sub: 'iosapps', body: 'new text', now: NOW });
  assert.equal(r.ok, true);
});

test('checkCadence blocks substantially similar text even for another sub long ago', () => {
  const body = 'I built a timer app with phase colors big digits and no subscription for workouts';
  const r = checkCadence({
    log: [entry('other', 40, body)],
    sub: 'iosapps',
    body: body + ' please try',
    now: NOW,
  });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /similar/i);
});

test('checkCadence ignores comment entries in the log', () => {
  const c = { ...entry('iosapps', 1), type: 'comment' };
  const r = checkCadence({ log: [c], sub: 'iosapps', body: 'new', now: NOW });
  assert.equal(r.ok, true);
});

test('parseSubmitResponse returns url/id/name on success and throws Reddit errors', () => {
  const ok = parseSubmitResponse({
    json: {
      errors: [],
      data: { url: 'https://www.reddit.com/r/x/comments/1ab/t/', id: '1ab', name: 't3_1ab' },
    },
  });
  assert.deepEqual(ok, {
    url: 'https://www.reddit.com/r/x/comments/1ab/t/',
    id: '1ab',
    name: 't3_1ab',
  });
  assert.throws(
    () =>
      parseSubmitResponse({
        json: { errors: [['SUBREDDIT_NOTALLOWED', "you aren't allowed to post there", 'sr']] },
      }),
    /SUBREDDIT_NOTALLOWED/,
  );
});

test('postIdFrom accepts a post URL, a fullname, or a bare id', () => {
  assert.equal(
    postIdFrom('https://www.reddit.com/r/iOSProgramming/comments/1abc2de/some_title/'),
    '1abc2de',
  );
  assert.equal(postIdFrom('t3_1abc2de'), '1abc2de');
  assert.equal(postIdFrom('1abc2de'), '1abc2de');
});

test('parseCommentResponse returns the new comment name and permalink', async () => {
  const { parseCommentResponse } = await import('./lib.mjs');
  const r = parseCommentResponse({
    json: {
      errors: [],
      data: {
        things: [{ kind: 't1', data: { name: 't1_zz', permalink: '/r/x/comments/1ab/t/zz/' } }],
      },
    },
  });
  assert.deepEqual(r, {
    name: 't1_zz',
    permalink: 'https://www.reddit.com/r/x/comments/1ab/t/zz/',
  });
  assert.throws(
    () => parseCommentResponse({ json: { errors: [['RATELIMIT', 'slow down', 'ratelimit']] } }),
    /RATELIMIT/,
  );
});

test('flattenComments walks nested replies in order and skips "more" stubs', async () => {
  const { flattenComments } = await import('./lib.mjs');
  const c = (name, author, body, replies = '') => ({
    kind: 't1',
    data: {
      name,
      author,
      body,
      created_utc: 1700000000,
      permalink: '/r/x/comments/1ab/t/' + name + '/',
      replies,
    },
  });
  const listing = (children) => ({ kind: 'Listing', data: { children } });
  const tree = [
    listing([{ kind: 't3', data: { name: 't3_1ab' } }]),
    listing([
      c(
        'a',
        'alice',
        'top',
        listing([c('b', 'bob', 'nested'), { kind: 'more', data: { count: 3 } }]),
      ),
      c('c', 'carol', 'second'),
    ]),
  ];
  const flat = flattenComments(tree);
  assert.deepEqual(
    flat.map((x) => [x.name, x.author, x.body, x.depth]),
    [
      ['a', 'alice', 'top', 0],
      ['b', 'bob', 'nested', 1],
      ['c', 'carol', 'second', 0],
    ],
  );
  assert.equal(flat[0].permalink, 'https://www.reddit.com/r/x/comments/1ab/t/a/');
});
