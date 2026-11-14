// story #4927 AC1 — the contrast guard's marker wait (e2e/support/marker-wait.ts), run for real in chromium against a local page: a marker that comes in time passes,
// and one that does not throws the SAME first line as before with the diagnostics under it — never a different error, never swallowed. No sign-in, no app: a tiny http
// server stands in for the page and its marker request, so this runs in the layout config (no webServer).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import { installMarkerWatch, waitForPageMarker, PAGE_MARKER_TIMEOUT_MS, LATE_WATCH_MAX_MS } from './support/marker-wait';

installMarkerWatch();

const MARKER = { kind: 'response', urlIncludes: '/api/activation/checklist' } as const;
const FAST = { timeoutMs: 700, lateWatchMaxMs: 2500 };

async function serve(page: string, markerDelayMs: number | null): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((rq, rs) => {
    const url = rq.url ?? '/';
    if (url === '/') {
      rs.setHeader('content-type', 'text/html');
      rs.end(page);
    } else if (url.startsWith('/stream/')) {
      rs.writeHead(200, { 'content-type': 'text/event-stream' });
      rs.write(': open\n\n');
    } else if (url.startsWith('/slow.js')) {
      setTimeout(() => { rs.setHeader('content-type', 'text/javascript'); rs.end('//'); }, 1500); // a blocking script: the document is not «loaded» (and page.reload does not return) until it is in
    } else if (url.startsWith('/hang')) {
      return; // a request that is never answered keeps the page from going network-idle (an open EventSource does not: playwright does not count it)
    } else if (url.startsWith('/api/activation/checklist')) {
      if (markerDelayMs == null) return; // never answered
      setTimeout(() => { rs.setHeader('content-type', 'application/json'); rs.end('{}'); }, markerDelayMs);
    } else {
      rs.statusCode = 404;
      rs.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const asksMarker = (streamCount = 0) => `<script>for (let i = 0; i < ${streamCount}; i++) new EventSource('/stream/' + i); setTimeout(() => fetch('/api/activation/checklist?token=SECRETVALUE'), 40);</script>ok`;

test('the defaults of the wait are the ones the guard always had (5000 ms limit)', () => {
  expect(PAGE_MARKER_TIMEOUT_MS).toBe(1); // PROOF BRANCH ONLY: the limit is 1 ms here on purpose, so the layout step stays green and the contrast step (which then misses on purpose) is reached
  expect(LATE_WATCH_MAX_MS).toBeGreaterThan(0);
});

test('a marker answered in time passes and throws nothing', async ({ page }) => {
  const s = await serve(asksMarker(), 50);
  try {
    await page.goto(s.url);
    await waitForPageMarker(page, MARKER, '/x', FAST);
  } finally { await s.close(); }
});

test('a marker answered LATE: the first line is unchanged and the report says the request went out and the answer came after the limit', async ({ page }) => {
  const s = await serve(asksMarker(), 1500);
  try {
    await page.goto(s.url);
    const err = await waitForPageMarker(page, MARKER, '/x', FAST).then(() => null, (e: Error) => e);
    expect(err, 'must throw').not.toBeNull();
    const [first, ...rest] = err!.message.split('\n');
    expect(first).toBe('contrast-guard precondition: page marker not seen — /x kind:urlIncludes(/api/activation/checklist) within 700ms');
    const report = rest.join('\n');
    expect(report).toContain('── 진단 (story 4927) · 시도 #1 · /x ──');
    expect(report).toMatch(/표식 응답이 시간 초과보다 \d+ms 늦게 왔다/);
    expect(report).toContain('reload → 표식 요청 발행:');
    expect(report).toContain('GET /api/activation/checklist → 200');
    expect(report).not.toContain('SECRETVALUE'); // the query is never recorded
  } finally { await s.close(); }
});

test('a SLOW reload: the marker answered after the limit but before the reload returned is still reported as late (the deadline is the waiter\'s, not the time the report started)', async ({ page }) => {
  // the document is held open by a blocking script for 1.5 s; the marker fetch (started by an inline script before it) is answered at 0.9 s — after the 0.7 s limit, before the reload returns
  const s = await serve("<script>setTimeout(() => fetch('/api/activation/checklist'), 20)</script><script src=\"/slow.js\"></script>ok", 880);
  try {
    await page.goto(s.url);
    const err = await waitForPageMarker(page, MARKER, '/slow', FAST).then(() => null, (e: Error) => e);
    expect(err, 'must throw').not.toBeNull();
    expect(err!.message).toMatch(/표식 응답이 시간 초과보다 \d+ms 늦게 왔다/);
    expect(err!.message).toMatch(/reload 호출이 돌아온 때: reload \+\d+ms \(시간 초과 뒤 — 문서가 늦게 뜸\)/);
    expect(err!.message).toMatch(/reload → 시간 초과: 7\d\dms|reload → 시간 초과: 700ms/); // the deadline, not the (later) time the code got to run
    // the late watch itself was ~0 (the marker had answered before the reload returned): the «time watched» is not the time since the deadline
    const watched = Number(/그 뒤 더 지켜본 시간: (\d+)ms/.exec(err!.message)?.[1]);
    expect(watched).toBeLessThan(400);
  } finally { await s.close(); }
});

test('a marker never asked for: the report says the page never asked', async ({ page }) => {
  const s = await serve('<script>/* the page does not ask */</script>ok', 50);
  try {
    await page.goto(s.url);
    const err = await waitForPageMarker(page, MARKER, '/y', FAST).then(() => null, (e: Error) => e);
    expect(err!.message.split('\n')[0]).toContain('page marker not seen — /y');
    expect(err!.message).toContain('표식 요청이 reload 뒤 한 번도 안 나갔다');
    expect(err!.message).toContain('reload → 표식 요청 발행: 안 나감');
  } finally { await s.close(); }
});

test('a marker asked for but never answered, with five streams open: the report counts the open streams (five + the marker = six, the browser limit)', async ({ page }) => {
  const s = await serve(asksMarker(5), null);
  try {
    await page.goto(s.url);
    const err = await waitForPageMarker(page, MARKER, '/z', { timeoutMs: 700, lateWatchMaxMs: 800 }).then(() => null, (e: Error) => e);
    expect(err, 'must throw').not.toBeNull();
    expect(err!.message.split('\n')[0]).toContain('page marker not seen — /z');
    expect(err!.message).toContain('시간 초과 순간 6개(스트림 5개)'); // five streams + the unanswered marker request hold the page's six connections
    expect(err!.message).toContain('HTTP/1.1이면 한도 6');
  } finally { await s.close(); }
});

test('the networkidle marker that never settles throws the networkidle first line with a report', async ({ page }) => {
  const s = await serve("<script>fetch('/hang')</script>ok", 50);
  try {
    await page.goto(s.url);
    const err = await waitForPageMarker(page, { kind: 'networkidle' }, '/n', { timeoutMs: 700, lateWatchMaxMs: 800 }).then(() => null, (e: Error) => e);
    expect(err!.message.split('\n')[0]).toBe('contrast-guard precondition: page marker not seen — /n kind:networkidle within 700ms');
    expect(err!.message).toContain('── 진단 (story 4927)');
  } finally { await s.close(); }
});

test('a diagnostics failure never hides the original error: the first line is still the precondition line', async ({ page }) => {
  const s = await serve(asksMarker(), null);
  try {
    await page.goto(s.url);
    setTimeout(() => { void page.close(); }, 250); // the page goes away mid-wait: waiting on it fails, and so does building the report
    const err = await waitForPageMarker(page, MARKER, '/gone', FAST).then(() => null, (e: Error) => e);
    expect(err, 'must throw').not.toBeNull();
    expect(err!.message.split('\n')[0]).toBe('contrast-guard precondition: page marker not seen — /gone kind:urlIncludes(/api/activation/checklist) within 700ms');
    expect(err!.message).toContain('── 진단 만들기 실패 (story 4927) ──'); // and the fallback line says why there is no report
  } finally { await s.close(); }
});
