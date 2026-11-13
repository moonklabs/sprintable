// story #4927 AC1 — what a «page marker not seen» failure of the contrast guard carries. The old message said only «not seen within 5000ms»,
// which cannot tell apart: the page never asked (render late), asked and the browser held the request back (connection limit · queue),
// asked and the server answered late (Next dev compiling the route), or answered only after the wait ended. Each of those has a different root.
//
// Pure parts (format · parse · classify) are unit-tested in src/lib/e2e-marker-diagnostics.test.ts; `watchNetwork` is the thin playwright part.
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import type { Page, Request } from '@playwright/test';
import { formatRecord, isCompileFamily, normalizeRoute, pickAllowed, safeErrorName, safeMethod, safeNetError, safeResourceType, type AllowedRecord } from './server-line-allowlist.mjs';

// What this file may keep is a FIXED LIST OF FIELDS (PO 11-14 — an allowlist, not a list of patterns to mask): per request method · pathname (id-looking segments replaced) · resource type · status · times · stall · whether it is the
// page's origin · open/abandoned flags; per server line only the allowed fields of server-line-allowlist.mjs; per browser console/page error only its kind, the script's pathname or the error NAME — never a message, header, cookie, body,
// full URL, env value or raw line. There is no field for them, so there is nothing to mask.

export interface NetRecord {
  method: string;
  /** scheme + host + port of the request — the browser's per-origin connection limit counts requests of one origin. */
  origin: string;
  /** pathname only (no query, no origin; id-looking segments replaced by :id) — enough to name the request, nothing that could carry a value. */
  path: string;
  resourceType: string;
  requestAt: number;
  responseAt: number | null;
  status: number | null;
  finishedAt: number | null;
  failedAt: number | null;
  /** set when a main-frame navigation (reload) committed while this request of the OLD document was still open: playwright sends no finished/failed event for it, but its connection is released. */
  abandonedAt: number | null;
  failure: string | null;
  /** browser-side wait: how long after the request was created it actually began to be sent (chromium timing.requestStart). null = unknown. */
  stallMs: number | null;
}

export interface ServerLine { at: number; rec: AllowedRecord }
export interface ConsoleLine { at: number; text: string }

export interface MarkerReportInput {
  attempt: number;
  pagePath: string;
  /** the marker's url fragment, or null for the networkidle marker. */
  urlIncludes: string | null;
  timeoutMs: number;
  testStartedAt: number;
  reloadAt: number;
  timedOutAt: number;
  /** when `page.reload()` returned (the document was committed), or null if it never did — a slow reload is a finding of its own. */
  reloadDoneAt: number | null;
  /** how long the late watch itself ran after the miss (0 = not at all) — only the watching loop, not the time spent building the report. */
  lateWatchMs: number;
  /** when the report was finished (the end of the server-record window); defaults to timedOutAt + lateWatchMs. */
  endAt?: number;
  /** networkidle marker only: the time it became idle during the late watch, or null. */
  lateIdleAt: number | null;
  records: NetRecord[];
  consoleLines: ConsoleLine[];
  serverLines: ServerLine[];
  /** false = no log file (webServer not started by this config); the report then says so instead of showing an empty window. */
  serverLogAvailable: boolean;
  dom: string | null;
}

const MAX_REQUEST_ROWS = 40;
const MAX_SERVER_ROWS = 60;
const MAX_PENDING_ROWS = 15;
const MAX_CONSOLE_ROWS = 8;
const SAME_ORIGIN_H1_LIMIT = 6;

/** «<epoch>\t<json>» per line → only the allowed fields of each record (a line of any other shape — e.g. raw text from an older wrapper or a hand edit — yields nothing). */
export function parseServerLog(text: string): ServerLine[] {
  const out: ServerLine[] = [];
  for (const raw of text.split('\n')) {
    const tab = raw.indexOf('\t');
    if (tab <= 0) continue;
    const at = Number(raw.slice(0, tab));
    if (!Number.isFinite(at)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw.slice(tab + 1)); } catch { continue; }
    const rec = pickAllowed(parsed);
    if (rec) out.push({ at, rec });
  }
  return out;
}

/** the file is append-only and a CI job runs several e2e steps into it: only the last 2 MB can hold the window of one failing test. */
export const MAX_LOG_TAIL_BYTES = 2 * 1024 * 1024;

export function readServerLog(file: string | undefined): { available: boolean; lines: ServerLine[] } {
  if (!file || !existsSync(file)) return { available: false, lines: [] };
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // the first line of a tail is cut in the middle
    return { available: true, lines: parseServerLog(text) };
  } catch {
    return { available: false, lines: [] };
  } finally {
    if (fd != null) { try { closeSync(fd); } catch { /* nothing to do */ } }
  }
}

const rel = (at: number, base: number) => {
  const d = Math.round(at - base);
  return `${d >= 0 ? '+' : ''}${d}ms`;
};

/** a long-lived response: chromium's EventSource type, or a path that names a stream. */
export const isStream = (r: NetRecord) => r.resourceType === 'eventsource' || /stream/i.test(r.path);

/** The marker request to speak about: the one that was answered, else the last one the page made after the reload (an early failed attempt must not hide a later one). */
export function pickMarker(records: NetRecord[], urlIncludes: string, reloadAt: number): NetRecord | undefined {
  const asked = records.filter((r) => isMarkerRecord(r, urlIncludes) && r.requestAt >= reloadAt);
  return asked.find((r) => r.responseAt != null) ?? asked[asked.length - 1];
}

const isMarkerRecord = (r: NetRecord, urlIncludes: string | null) => urlIncludes != null && r.path.includes(urlIncludes);

/** requests that had been created by `at` and had neither a response nor a failure by then. */
export function pendingAt(records: NetRecord[], at: number): NetRecord[] {
  return records.filter((r) => r.requestAt <= at && (r.responseAt == null || r.responseAt > at) && (r.failedAt == null || r.failedAt > at) && (r.abandonedAt == null || r.abandonedAt > at));
}

/** requests whose connection is still in use at `at` (created, and neither finished nor failed yet) — a stream that has sent its headers still holds one. */
export function openAt(records: NetRecord[], at: number): NetRecord[] {
  return records.filter((r) => r.requestAt <= at && (r.finishedAt == null || r.finishedAt > at) && (r.failedAt == null || r.failedAt > at) && (r.abandonedAt == null || r.abandonedAt > at));
}

/** One line that names the case, from the facts only (it says «unknown» rather than guess). */
export function classifyMarker(input: Pick<MarkerReportInput, 'urlIncludes' | 'reloadAt' | 'timedOutAt' | 'records' | 'lateIdleAt'>): string {
  const { urlIncludes, reloadAt, timedOutAt, records, lateIdleAt } = input;
  if (urlIncludes == null) {
    return lateIdleAt != null
      ? `networkidle은 시간 초과보다 ${Math.round(lateIdleAt - timedOutAt)}ms 늦게 섰다(= 늦은 것)`
      : 'networkidle이 끝까지 안 섰다 — 대기 중 요청 목록을 볼 것';
  }
  const first = pickMarker(records, urlIncludes, reloadAt);
  if (!first) return '표식 요청이 reload 뒤 한 번도 안 나갔다(페이지가 안 물었다 — 렌더 · 하이드레이션이 늦거나 안 됨)';
  if (first.failedAt != null && first.responseAt == null) return `표식 요청이 나갔으나 실패했다(${first.failure ?? 'failure 불명'})`;
  if (first.abandonedAt != null && first.responseAt == null) return '표식 요청이 나갔으나 응답 前에 문서가 바뀌어(reload · 이동) 끊겼다 — 그 뒤 새 문서의 요청은 아래 표';
  if (first.responseAt == null) {
    const stall = first.stallMs;
    // the other requests that held a connection when the wait ended: at the per-origin HTTP/1.1 limit, the marker request (and the document) queue in the browser
    const others = openAt(records, timedOutAt).filter((r) => r !== first && r.origin === first.origin).length;
    const limitHint = others >= SAME_ORIGIN_H1_LIMIT ? ` · 같은 출처 연결 ${others}개가 열려 있어 HTTP/1.1이면 한도(${SAME_ORIGIN_H1_LIMIT})에 닿음 — 브라우저 줄 의심` : '';
    return (stall != null && stall > 0
      ? `표식 요청이 나갔고 브라우저가 ${Math.round(stall)}ms 쥐고 있었다 — 응답은 아직 안 옴`
      : '표식 요청이 나갔으나 응답이 끝까지 안 왔다(서버 처리 중이거나 브라우저 줄) — 서버 줄 · 대기 요청을 볼 것') + limitHint;
  }
  const lateBy = first.responseAt - timedOutAt;
  if (lateBy > 0) return `표식 응답이 시간 초과보다 ${Math.round(lateBy)}ms 늦게 왔다(= 요청은 갔고 응답이 늦음 · 서버 줄의 컴파일 시간과 대조)`;
  return '표식 응답은 시간 안에 왔다(이 오류가 난 까닭이 다름 — 아래 표를 볼 것)';
}

export function formatMarkerReport(input: MarkerReportInput): string {
  const { attempt, pagePath, urlIncludes, timeoutMs, testStartedAt, reloadAt, timedOutAt, reloadDoneAt, lateWatchMs, records, consoleLines, serverLines, serverLogAvailable, dom } = input;
  const out: string[] = [];
  out.push(`── 진단 (story 4927) · 시도 #${attempt} · ${pagePath} ──`);
  out.push(`판정: ${classifyMarker(input)}`);
  out.push(`시험 시작 → reload 호출: ${Math.round(reloadAt - testStartedAt)}ms · reload → 시간 초과: ${Math.round(timedOutAt - reloadAt)}ms (한도 ${timeoutMs}ms) · 그 뒤 더 지켜본 시간: ${lateWatchMs}ms`);
  out.push(`reload 호출이 돌아온 때: ${reloadDoneAt != null ? `reload ${rel(reloadDoneAt, reloadAt)}${reloadDoneAt > timedOutAt ? ' (시간 초과 뒤 — 문서가 늦게 뜸)' : ''}` : '안 돌아옴(문서가 안 뜸)'}`);

  const afterReload = records.filter((r) => r.requestAt >= reloadAt).sort((a, b) => a.requestAt - b.requestAt);
  const firstAny = afterReload[0];
  out.push(`reload → 첫 요청: ${firstAny ? `${Math.round(firstAny.requestAt - reloadAt)}ms (${firstAny.method} ${firstAny.path})` : '요청 없음'}`);
  if (urlIncludes != null) {
    const marker = pickMarker(records, urlIncludes, reloadAt);
    out.push(`reload → 표식 요청 발행: ${marker ? `${Math.round(marker.requestAt - reloadAt)}ms` : '안 나감'}`);
    if (marker) {
      out.push(`표식 응답: ${marker.responseAt != null ? `reload ${rel(marker.responseAt, reloadAt)} · status ${marker.status} · 요청 → 응답 ${Math.round(marker.responseAt - marker.requestAt)}ms${marker.responseAt > timedOutAt ? ' (시간 초과 뒤에 옴)' : ''}` : '끝까지 안 옴'}${marker.stallMs != null ? ` · 브라우저 대기(stall) ${Math.round(marker.stallMs)}ms` : ''}`);
    }
  }

  // same-origin connection budget (HTTP/1.1 = 6 per origin in chromium): what was still open when the page was reloaded (the old document's
  // streams) and when the wait ended, and how many of those are streams (EventSource · …stream paths).
  // the page's origin: the marker request's, else the first request after the reload (another origin's requests do not share its connection budget)
  const pageOrigin = (urlIncludes != null ? pickMarker(records, urlIncludes, reloadAt) : undefined)?.origin ?? firstAny?.origin;
  const sameOrigin = (r: NetRecord) => pageOrigin == null || r.origin === pageOrigin;
  const openAtReload = openAt(records, reloadAt).filter(sameOrigin);
  const openAtTimeout = openAt(records, timedOutAt).filter(sameOrigin);
  const pending = pendingAt(records, timedOutAt);
  out.push(`reload 순간 연결을 쥐고 있던 요청 ${openAtReload.length}개(스트림 ${openAtReload.filter(isStream).length}개) · 시간 초과 순간 ${openAtTimeout.length}개(스트림 ${openAtTimeout.filter(isStream).length}개) · 같은 출처 · HTTP/1.1이면 한도 ${SAME_ORIGIN_H1_LIMIT}`);
  out.push(`시간 초과 순간 응답 못 받은 요청 ${pending.length}개:`);
  for (const r of pending.slice(0, MAX_PENDING_ROWS)) out.push(`  ${rel(r.requestAt, reloadAt)} ${r.method} ${r.path} (${r.resourceType}) · ${Math.round(timedOutAt - r.requestAt)}ms째 대기`);
  if (pending.length > MAX_PENDING_ROWS) out.push(`  … ${pending.length - MAX_PENDING_ROWS}개 더`);

  out.push(`reload 뒤 요청 ${afterReload.length}개(reload 기준 시각 · 상태 · 응답까지):`);
  for (const r of afterReload.slice(0, MAX_REQUEST_ROWS)) {
    const state = r.failedAt != null && r.responseAt == null ? `실패 ${r.failure ?? ''}`.trim() : r.responseAt != null ? `${r.status} ${rel(r.responseAt, reloadAt)}` : r.abandonedAt != null ? `끊김(문서 이동) ${rel(r.abandonedAt, reloadAt)}` : '응답 없음';
    out.push(`  ${rel(r.requestAt, reloadAt)} ${r.method} ${r.path} → ${state}${r.stallMs != null && r.stallMs >= 50 ? ` · 브라우저 대기 ${Math.round(r.stallMs)}ms` : ''}`);
  }
  if (afterReload.length > MAX_REQUEST_ROWS) out.push(`  … ${afterReload.length - MAX_REQUEST_ROWS}개 더`);

  if (!serverLogAvailable) {
    out.push('Next 서버 기록: 수집 안 됨(E2E_WEBSERVER_LOG 파일 없음 — webServer를 이 설정이 띄우지 않았다)');
  } else {
    const end = input.endAt ?? timedOutAt + lateWatchMs;
    const inTest = serverLines.filter((l) => l.at >= testStartedAt && l.at <= end);
    const compiles = inTest.filter((l) => isCompileFamily(l.rec));
    out.push(`Next 서버 기록(허용한 칸만: 요청 · 컴파일 · 준비 · 오류 이름): 시험 시작~끝 ${inTest.length}건(그중 컴파일 계열 ${compiles.length}건) · 시각은 reload 기준 · 원문 줄은 담지 않음`);
    for (const l of inTest.slice(0, MAX_SERVER_ROWS)) out.push(`  ${rel(l.at, reloadAt)} ${formatRecord(l.rec)}`);
    if (inTest.length > MAX_SERVER_ROWS) out.push(`  … ${inTest.length - MAX_SERVER_ROWS}건 더 (전부는 apps/web/playwright/server-logs/next-dev.log)`);
  }

  if (consoleLines.length > 0) {
    out.push(`브라우저 콘솔 오류 · 페이지 오류 ${consoleLines.length}개:`);
    for (const c of consoleLines.slice(0, MAX_CONSOLE_ROWS)) out.push(`  ${rel(c.at, reloadAt)} ${c.text.slice(0, 200)}`);
  }
  if (dom) out.push(`페이지 상태: ${dom}`);
  return out.join('\n');
}

// ── the playwright part ──────────────────────────────────────────────────────────────────────────────────────────────

export interface NetworkWatch {
  records(): NetRecord[];
  consoleLines(): ConsoleLine[];
  stop(): void;
}

/** Chromium's failure text is a code («net::ERR_ABORTED»); only a code from the fixed list is kept, any other text becomes «net::ERR_OTHER». */
export function safeFailure(text: string | undefined | null): string | null {
  return safeNetError(text);
}

export function watchNetwork(page: Page): NetworkWatch {
  const byRequest = new Map<Request, NetRecord>();
  const consoleLines: ConsoleLine[] = [];
  const onRequest = (req: Request) => {
    const path = normalizeRoute(req.url()); // pathname only — never the query · user info · host
    let origin = '';
    try { origin = new URL(req.url()).origin; } catch { /* unknown */ }
    byRequest.set(req, { method: safeMethod(req.method()), origin, path, resourceType: safeResourceType(req.resourceType()), requestAt: Date.now(), responseAt: null, status: null, finishedAt: null, failedAt: null, abandonedAt: null, failure: null, stallMs: null });
  };
  // browser-side wait = chromium's timing.requestStart (ms from the request's start to the first byte sent) — known as soon as the response head is in
  const stallOf = (req: Request): number | null => { const t = req.timing(); return t.requestStart >= 0 ? t.requestStart : null; };
  const onResponse = (res: { request(): Request; status(): number }) => {
    const rec = byRequest.get(res.request());
    if (rec) { rec.responseAt = Date.now(); rec.status = res.status(); rec.stallMs = stallOf(res.request()); }
  };
  const onFinished = (req: Request) => {
    const rec = byRequest.get(req);
    if (!rec) return;
    rec.finishedAt = Date.now();
    rec.stallMs = stallOf(req) ?? rec.stallMs;
  };
  const onFailed = (req: Request) => {
    const rec = byRequest.get(req);
    if (rec) { rec.failedAt = Date.now(); rec.failure = safeFailure(req.failure()?.errorText); }
  };
  // a committed main-frame navigation ends the old document's requests: mark those still open as abandoned (the requests created before the navigation's own document request)
  const onNavigated = (frame: unknown) => {
    if (frame !== page.mainFrame()) return;
    // creation order (not clock time: two requests can be created in the same millisecond) — everything created before the navigation's own document request belongs to the old document
    const entries = [...byRequest.entries()];
    let docAt = -1;
    entries.forEach(([req], i) => { if (req.resourceType() === 'document' && req.frame() === frame) docAt = i; });
    if (docAt < 0) return;
    const now = Date.now();
    entries.slice(0, docAt).forEach(([, rec]) => {
      if (rec.finishedAt == null && rec.failedAt == null && rec.abandonedAt == null) rec.abandonedAt = now;
    });
  };
  // a console error / page error: only THAT it happened, where (the script's pathname) and the error NAME — the message text is not kept
  const onConsole = (msg: { type(): string; location?(): { url?: string } }) => {
    if (msg.type() === 'error') consoleLines.push({ at: Date.now(), text: `console.error${msg.location ? ` @ ${normalizeRoute(msg.location().url ?? '')}` : ''}` });
  };
  const onPageError = (err: Error) => { consoleLines.push({ at: Date.now(), text: `pageerror ${safeErrorName(err?.name)}` }); };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  page.on('framenavigated', onNavigated);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  return {
    records: () => [...byRequest.values()],
    consoleLines: () => consoleLines,
    stop: () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
      page.off('framenavigated', onNavigated);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
  };
}
