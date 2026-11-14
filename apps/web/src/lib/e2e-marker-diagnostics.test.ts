// story #4927 AC1 — the diagnostics a contrast-guard «page marker not seen» failure carries (apps/web/e2e/support/marker-diagnostics.ts), the thin
// shell that collects the Next dev server's lines with a clock (e2e/support/dev-server-logged.mjs), and the guard that the spec / config keep wired to
// them. (e2e/ is outside vitest's include, so the pure parts are tested from here.)
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DOC_READY_STATES, ERROR_CODES, ERROR_NAMES, HTTP_METHODS, NET_ERRORS, RESOURCE_TYPES, formatRecord, isCompileFamily, normalizeRoute, parseServerLine, pickAllowed, safeErrorCode, safeErrorName, safeMethod, safeNetError, safeReadyState, safeResourceType } from '../../e2e/support/server-line-allowlist.mjs';
import {
  MAX_LOG_TAIL_BYTES, classifyMarker, formatMarkerReport, openAt, parseServerLog, pendingAt, pickMarker, readServerLog, safeFailure, watchNetwork,
  type MarkerReportInput, type NetRecord,
} from '../../e2e/support/marker-diagnostics';
import { lateWatchBudgetMs } from '../../e2e/support/marker-wait';

const WEB = join(__dirname, '..', '..');
const T0 = 1_000_000; // test start
const RELOAD = T0 + 6_000;
const TIMED_OUT = RELOAD + 5_000;

function rec(over: Partial<NetRecord> = {}): NetRecord {
  return { method: 'GET', origin: 'http://localhost:3108', path: '/x', resourceType: 'fetch', requestAt: RELOAD + 100, responseAt: null, status: null, finishedAt: null, failedAt: null, abandonedAt: null, failure: null, stallMs: null, ...over };
}

function input(over: Partial<MarkerReportInput> = {}): MarkerReportInput {
  return {
    attempt: 1, pagePath: '/settings', urlIncludes: '/api/activation/checklist', timeoutMs: 5000,
    testStartedAt: T0, reloadAt: RELOAD, timedOutAt: TIMED_OUT, reloadDoneAt: RELOAD + 30, lateWatchMs: 0, lateIdleAt: null,
    records: [], consoleLines: [], serverLines: [], serverLogAvailable: true, dom: null, ...over,
  };
}

describe('서버 줄 파일 읽기 (story 4927)', () => {
  it('⭐«<epoch>\\t<json>» 형식만 읽고, 각 기록에서 허용한 칸만 다시 뽑는다 — 시각 아닌 줄 · 탭 없는 줄 · json 아닌 줄 · 모르는 종류는 버림', () => {
    const lines = parseServerLog([
      '1000\t{"kind":"compile","phase":"compiled","route":"/settings","ms":4200}',
      'not-a-time\t{"kind":"ready","ms":1}',
      'no tab here',
      '2000\tthis is raw text, not json',
      '3000\t{"kind":"mystery","x":1}',
      '4000\t{"kind":"ready","ms":212}',
      '',
    ].join('\n'));
    expect(lines).toEqual([
      { at: 1000, rec: { kind: 'compile', phase: 'compiled', route: '/settings', ms: 4200 } },
      { at: 4000, rec: { kind: 'ready', ms: 212 } },
    ]);
  });

  it('⭐기록에 허용한 칸 말고 다른 칸(헤더 · 본문 · 쿠키 · 원문)이 들어 있어도 읽는 쪽에서 못 나온다', () => {
    const [one] = parseServerLog(`1000\t${JSON.stringify({ kind: 'request', method: 'GET', route: '/api/x', status: 200, ms: 5, parts: { compile: 3, cookie: 99 }, headers: { cookie: 'sp_rt=LEAK1' }, body: 'LEAK2', raw: 'LEAK3' })}`);
    expect(Object.keys(one!.rec).sort()).toEqual(['kind', 'method', 'ms', 'parts', 'route', 'status']);
    expect(Object.keys((one!.rec as { parts: object }).parts)).toEqual(['compile']);
    expect(JSON.stringify(one)).not.toMatch(/LEAK|sp_rt/);
  });
});

describe('표식 놓침을 가르는 판정 (story 4927)', () => {
  const base = { urlIncludes: '/api/activation/checklist', reloadAt: RELOAD, timedOutAt: TIMED_OUT, lateIdleAt: null };

  it('⭐표식 요청이 reload 뒤 한 번도 안 나갔다 — 페이지가 안 물은 경우', () => {
    expect(classifyMarker({ ...base, records: [rec({ path: '/api/other' })] })).toContain('한 번도 안 나갔다');
    // a marker request from BEFORE the reload does not count
    expect(classifyMarker({ ...base, records: [rec({ path: '/api/activation/checklist', requestAt: RELOAD - 50, responseAt: RELOAD - 10 })] })).toContain('한 번도 안 나갔다');
  });

  it('⭐나갔는데 응답이 끝까지 안 왔다 — 브라우저 대기(stall)가 있으면 그 값을 말한다', () => {
    const noStall = classifyMarker({ ...base, records: [rec({ path: '/api/activation/checklist' })] });
    expect(noStall).toContain('응답이 끝까지 안 왔다');
    const stalled = classifyMarker({ ...base, records: [rec({ path: '/api/activation/checklist', stallMs: 4200 })] });
    expect(stalled).toContain('4200ms');
    expect(stalled).toContain('브라우저');
  });

  it('⭐표식 요청이 응답 없고 같은 출처 연결이 한도(6) 이상 열려 있으면 «브라우저 줄 의심»을 덧붙인다 · 5개 이하면 안 붙인다', () => {
    const stream = (n: number) => rec({ path: `/api/event-stream/${n}`, resourceType: 'eventsource', requestAt: RELOAD + n, responseAt: RELOAD + n + 2, status: 200 });
    const marker = rec({ path: '/api/activation/checklist', requestAt: RELOAD + 50 });
    const six = classifyMarker({ ...base, records: [...[1, 2, 3, 4, 5, 6].map(stream), marker] });
    expect(six).toContain('연결 6개가 열려 있어 HTTP/1.1이면 한도(6)에 닿음');
    expect(six).toContain('브라우저 줄 의심');
    const five = classifyMarker({ ...base, records: [...[1, 2, 3, 4, 5].map(stream), marker] });
    expect(five).not.toContain('브라우저 줄 의심');
    // other origins do not share the page's connection budget: six open requests of ANOTHER origin add nothing
    const foreign = [1, 2, 3, 4, 5, 6].map((n) => rec({ origin: 'https://cdn.example.test', path: `/img/${n}`, requestAt: RELOAD + n }));
    expect(classifyMarker({ ...base, records: [...foreign, marker] })).not.toContain('브라우저 줄 의심');
    // the marker itself is not one of «the others»
    expect(classifyMarker({ ...base, records: [marker] })).not.toContain('한도');
  });

  it('⭐응답이 시간 초과 뒤에 왔다 — 늦은 만큼을 말한다 · 시간 안에 왔으면 다른 까닭이라 말한다', () => {
    const late = classifyMarker({ ...base, records: [rec({ path: '/api/activation/checklist', responseAt: TIMED_OUT + 2210, status: 200 })] });
    expect(late).toContain('2210ms 늦게');
    const inTime = classifyMarker({ ...base, records: [rec({ path: '/api/activation/checklist', responseAt: TIMED_OUT - 100, status: 200 })] });
    expect(inTime).toContain('시간 안에 왔다');
  });

  it('⭐표식 요청이 응답 前에 문서가 바뀌어 끊겼다(abandoned) — «응답 없음»이 아니라 그 사실을 말한다', () => {
    const out = classifyMarker({ ...base, records: [rec({ path: '/api/activation/checklist', abandonedAt: RELOAD + 400 })] });
    expect(out).toContain('문서가 바뀌어');
    expect(out).not.toContain('응답이 끝까지 안 왔다');
  });

  it('⭐표식 요청이 여럿이면 응답 받은 것을 말한다(앞선 실패 시도가 뒤의 늦은 응답을 가리지 않음) · 응답이 없으면 마지막 것', () => {
    const failedFirst = rec({ path: '/api/activation/checklist', requestAt: RELOAD + 10, failedAt: RELOAD + 20, failure: 'net::ERR_ABORTED' });
    const lateSecond = rec({ path: '/api/activation/checklist', requestAt: RELOAD + 900, responseAt: TIMED_OUT + 500, status: 200 });
    expect(pickMarker([failedFirst, lateSecond], '/api/activation/checklist', RELOAD)).toBe(lateSecond);
    expect(classifyMarker({ ...base, records: [failedFirst, lateSecond] })).toContain('500ms 늦게');
    const secondNoAnswer = rec({ path: '/api/activation/checklist', requestAt: RELOAD + 900 });
    expect(pickMarker([failedFirst, secondNoAnswer], '/api/activation/checklist', RELOAD)).toBe(secondNoAnswer);
    expect(pickMarker([], '/api/activation/checklist', RELOAD)).toBeUndefined();
  });

  it('요청이 실패했다 · networkidle 표식', () => {
    expect(classifyMarker({ ...base, records: [rec({ path: '/api/activation/checklist', failedAt: RELOAD + 300, failure: 'net::ERR_ABORTED' })] })).toContain('net::ERR_ABORTED');
    expect(classifyMarker({ ...base, urlIncludes: null, records: [], lateIdleAt: TIMED_OUT + 700 })).toContain('700ms 늦게 섰다');
    expect(classifyMarker({ ...base, urlIncludes: null, records: [] })).toContain('끝까지 안 섰다');
  });
});

describe('연결을 쥔 요청 · 응답 못 받은 요청 (story 4927)', () => {
  it('⭐스트림은 머리를 받아도(응답 有) 끝나기 前까지 연결을 쥔다 — pendingAt은 안 세고 openAt은 센다', () => {
    const stream = rec({ path: '/api/event-stream', resourceType: 'eventsource', requestAt: T0, responseAt: T0 + 20, status: 200 });
    const done = rec({ requestAt: T0, responseAt: T0 + 5, finishedAt: T0 + 9 });
    expect(pendingAt([stream, done], TIMED_OUT)).toEqual([]);
    expect(openAt([stream, done], TIMED_OUT)).toEqual([stream]);
    // closed before the moment → not open then
    expect(openAt([{ ...stream, failedAt: RELOAD - 1 }], TIMED_OUT)).toEqual([]);
    // created after the moment → not yet
    expect(openAt([rec({ requestAt: TIMED_OUT + 1 })], TIMED_OUT)).toEqual([]);
    // abandoned by a navigation before the moment → released; abandoned only after it → still open then (and open at the reload instant itself)
    expect(openAt([{ ...stream, abandonedAt: RELOAD + 5 }], TIMED_OUT)).toEqual([]);
    expect(openAt([{ ...stream, abandonedAt: RELOAD + 5 }], RELOAD)).toEqual([{ ...stream, abandonedAt: RELOAD + 5 }]);
    expect(pendingAt([rec({ requestAt: T0, abandonedAt: RELOAD + 5 })], TIMED_OUT)).toEqual([]);
  });
});

describe('진단 글 (story 4927)', () => {
  it('⭐첫 줄 · 시험 시작 → reload · reload → 첫 요청 · 표식 발행 · 응답 · 브라우저 대기를 숫자로 싣는다', () => {
    const text = formatMarkerReport(input({
      records: [
        rec({ path: '/settings', requestAt: RELOAD + 40, responseAt: RELOAD + 90, status: 200 }),
        rec({ path: '/api/activation/checklist', requestAt: RELOAD + 1234, responseAt: TIMED_OUT + 2210, status: 200, stallMs: 3100 }),
      ],
      lateWatchMs: 3000,
    }));
    expect(text).toContain('── 진단 (story 4927) · 시도 #1 · /settings ──');
    expect(text).toContain('시험 시작 → reload 호출: 6000ms');
    expect(text).toContain('reload → 첫 요청: 40ms (GET /settings)');
    expect(text).toContain('reload → 표식 요청 발행: 1234ms');
    expect(text).toContain('시간 초과 뒤에 옴');
    expect(text).toContain('브라우저 대기(stall) 3100ms');
    expect(text).toContain('그 뒤 더 지켜본 시간: 3000ms');
  });

  it('⭐reload 순간 · 시간 초과 순간 연결 쥔 수와 스트림 수를 따로 싣고 한도 6을 같이 적는다', () => {
    const streams = [1, 2, 3].map((n) => rec({ path: `/api/event-stream/${n}`, resourceType: 'eventsource', requestAt: T0 + n, responseAt: T0 + n + 5, status: 200 }));
    const text = formatMarkerReport(input({ records: [...streams, rec({ path: '/api/activation/checklist', requestAt: RELOAD + 10 })] }));
    expect(text).toContain('reload 순간 연결을 쥐고 있던 요청 3개(스트림 3개)');
    expect(text).toContain('시간 초과 순간 4개(스트림 3개)');
    expect(text).toContain('HTTP/1.1이면 한도 6');
    expect(text).toContain('시간 초과 순간 응답 못 받은 요청 1개');
  });

  it('⭐reload 호출이 돌아온 때를 싣는다 — 시간 초과 뒤면 «문서가 늦게 뜸» · 안 돌아왔으면 «안 돌아옴»', () => {
    expect(formatMarkerReport(input({ reloadDoneAt: RELOAD + 30 }))).toContain('reload 호출이 돌아온 때: reload +30ms\n');
    expect(formatMarkerReport(input({ reloadDoneAt: TIMED_OUT + 2000 }))).toContain('(시간 초과 뒤 — 문서가 늦게 뜸)');
    expect(formatMarkerReport(input({ reloadDoneAt: null }))).toContain('안 돌아옴(문서가 안 뜸)');
  });

  it('⭐끊긴 요청은 표에서 «끊김(문서 이동)»으로 적는다', () => {
    const text = formatMarkerReport(input({ records: [rec({ path: '/api/x', abandonedAt: RELOAD + 300 })] }));
    expect(text).toContain('GET /api/x → 끊김(문서 이동) +300ms');
  });

  it('⭐표식 요청이 안 나갔으면 «안 나감» · 요청이 하나도 없으면 «요청 없음»', () => {
    const text = formatMarkerReport(input());
    expect(text).toContain('reload → 첫 요청: 요청 없음');
    expect(text).toContain('reload → 표식 요청 발행: 안 나감');
  });

  it('⭐Next 서버 기록은 시험 구간만 reload 기준 시각으로 싣고, 컴파일 계열 수를 센다 · 구간 밖은 안 싣는다 · 원문 줄은 담지 않는다고 적는다', () => {
    const text = formatMarkerReport(input({
      serverLines: [
        { at: T0 - 5000, rec: { kind: 'ready', ms: 99 } },
        { at: RELOAD + 200, rec: { kind: 'compile', phase: 'compiling', route: '/api/activation/checklist', ms: null } },
        { at: RELOAD + 6400, rec: { kind: 'compile', phase: 'compiled', route: '/api/activation/checklist', ms: 6200 } },
        { at: RELOAD + 6500, rec: { kind: 'request', method: 'GET', route: '/api/activation/checklist', status: 200, ms: 6300, parts: { compile: 6000, render: 300 } } },
        { at: TIMED_OUT + 60_000, rec: { kind: 'ready', ms: 7 } },
      ],
      lateWatchMs: 2000, // the compile ended 1.4s after the wait did — the late watch covers it
    }));
    expect(text).toContain('시험 시작~끝 3건(그중 컴파일 계열 3건)');
    expect(text).toContain('원문 줄은 담지 않음');
    expect(text).toContain('+200ms compile compiling /api/activation/checklist');
    expect(text).toContain('+6400ms compile compiled /api/activation/checklist 6200ms');
    expect(text).toContain('+6500ms request GET /api/activation/checklist 200 6300ms (compile=6000ms render=300ms)');
    expect(text).not.toContain('ready 99ms');
    expect(text).not.toContain('ready 7ms');
  });

  it('서버 줄 파일이 없으면 «수집 안 됨»이라 말한다(빈 구간처럼 보이지 않게)', () => {
    expect(formatMarkerReport(input({ serverLogAvailable: false }))).toContain('수집 안 됨');
  });

  it('줄 수가 많아도 상한(요청 40 · 서버 60)에서 자르고 몇 개 더인지 적는다', () => {
    const records = Array.from({ length: 55 }, (_, i) => rec({ path: `/r/${i}`, requestAt: RELOAD + i, responseAt: RELOAD + i + 1, status: 200 }));
    const serverLines = Array.from({ length: 80 }, (_, i) => ({ at: RELOAD + i, rec: { kind: 'ready' as const, ms: i } }));
    const text = formatMarkerReport(input({ records, serverLines }));
    expect(text).toContain('… 15개 더');
    expect(text).toContain('… 20건 더');
  });

  it('브라우저 콘솔 오류 · 페이지 상태가 있으면 싣는다', () => {
    const text = formatMarkerReport(input({ consoleLines: [{ at: RELOAD + 100, text: 'pageerror TypeError' }], dom: 'readyState=interactive · path=/settings' }));
    expect(text).toContain('pageerror TypeError');
    expect(text).toContain('페이지 상태: readyState=interactive');
  });
});

describe('watchNetwork — playwright 이벤트를 기록으로 (story 4927)', () => {
  it('⭐메인 프레임 이동(reload)이 확정되면 옛 문서의 아직 안 끝난 요청은 «버려짐» — 연결을 놓은 것으로 센다(새 문서의 요청은 아님) · 이 버려짐이 없으면 reload 뒤 열린 연결이 두 배로 보인다', () => {
    const frame = { id: 'main' };
    const sub = { id: 'sub' };
    const page = Object.assign(new EventEmitter(), { mainFrame: () => frame });
    const w = watchNetwork(page as never);
    const mk = (url: string, type: string, of: object = frame) => ({ url: () => `http://localhost:3108${url}`, method: () => 'GET', resourceType: () => type, frame: () => of, timing: () => ({ requestStart: -1 }), failure: () => null });
    const oldStream = mk('/stream/0', 'eventsource');
    page.emit('request', oldStream);
    page.emit('request', mk('/frame', 'document', sub)); // an iframe's own document request: a navigation of ANOTHER frame
    const doc = mk('/', 'document'); // the reload's own document request, created after the old stream
    page.emit('request', doc);
    const newStream = mk('/stream/0', 'eventsource'); // created after the document request: the NEW document's
    page.emit('request', newStream);
    page.emit('framenavigated', sub); // the sub-frame navigated: the main document's requests stay open
    expect(w.records().every((r) => r.abandonedAt == null)).toBe(true);
    page.emit('framenavigated', frame);
    const [o, , d, n] = w.records();
    expect(o?.abandonedAt).not.toBeNull();
    expect(d?.abandonedAt).toBeNull(); // the document request itself
    expect(n?.abandonedAt).toBeNull();
    const at = Date.now() + 1;
    expect(openAt(w.records(), at).map((r) => r.resourceType)).toEqual(['document', 'eventsource']); // the main document + the new stream (the old document's iframe requests went with it)
    expect(w.records()[1]?.abandonedAt).not.toBeNull();
  });

  it('⭐브라우저 대기(stall)는 응답 머리가 온 순간 이미 적는다(끝나기 前에도) · 출처를 적는다', () => {
    const page = new EventEmitter();
    const w = watchNetwork(page as never);
    const a = { url: () => 'http://localhost:3108/api/activation/checklist', method: () => 'GET', resourceType: () => 'fetch', timing: () => ({ requestStart: 2750 }), failure: () => null };
    page.emit('request', a);
    page.emit('response', { request: () => a, status: () => 200 }); // no requestfinished yet — a stream that never ends
    expect(w.records()[0]?.stallMs).toBe(2750);
    expect(w.records()[0]?.origin).toBe('http://localhost:3108');
    expect(w.records()[0]?.finishedAt).toBeNull();
  });

  function fakeReq(url: string, type = 'fetch', timing = { requestStart: 120 }, failure: string | null = null) {
    return { url: () => url, method: () => 'GET', resourceType: () => type, timing: () => timing, failure: () => (failure ? { errorText: failure } : null) };
  }

  it('⭐콘솔 · 페이지 오류는 «있었다 + 스크립트 pathname» · «오류 이름»만 기록한다 — 본문(메시지)이 비밀을 담아도 기록엔 없다', () => {
    const page = new EventEmitter();
    const w = watchNetwork(page as never);
    page.emit('console', { type: () => 'error', text: () => 'fetch failed Authorization: Bearer abc123def456', location: () => ({ url: 'http://localhost:3108/_next/static/chunks/app.js?token=QQQ' }) });
    const err = new TypeError('bad sp_rt=ROTATED777');
    page.emit('pageerror', err);
    page.emit('pageerror', Object.assign(new Error('x'), { name: 'weird name with spaces Authorization: Bearer zzz999' }));
    expect(w.consoleLines().map((c) => c.text)).toEqual(['console.error @ /_next/static/chunks/app.js', 'pageerror TypeError', 'pageerror Other']);
    expect(JSON.stringify(w.consoleLines())).not.toMatch(/abc123def456|ROTATED777|QQQ|zzz999|Bearer/);
  });

  it('⭐경로만 남기고(쿼리 · 출처 버림) 요청 → 응답 → 끝남 · 브라우저 대기를 적는다 · stop 뒤엔 안 듣는다', () => {
    const page = new EventEmitter() as EventEmitter & { off: EventEmitter['off'] };
    const w = watchNetwork(page as never);
    const a = fakeReq('http://localhost:3108/api/activation/checklist?token=SECRET', 'fetch', { requestStart: 3100 });
    page.emit('request', a);
    page.emit('response', { request: () => a, status: () => 200 });
    page.emit('requestfinished', a);
    const [r] = w.records();
    expect(r?.path).toBe('/api/activation/checklist');
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(r?.status).toBe(200);
    expect(r?.stallMs).toBe(3100);
    expect(r?.finishedAt).not.toBeNull();
    w.stop();
    page.emit('request', fakeReq('http://localhost:3108/late'));
    expect(w.records()).toHaveLength(1);
  });

  it('실패한 요청의 까닭 · 콘솔 오류 · 페이지 오류를 적는다(콘솔 log/warn은 안 적음)', () => {
    const page = new EventEmitter();
    const w = watchNetwork(page as never);
    const b = fakeReq('http://localhost:3108/api/event-stream', 'eventsource', { requestStart: -1 }, 'net::ERR_ABORTED');
    page.emit('request', b);
    page.emit('requestfailed', b);
    page.emit('requestfinished', b); // a finished request whose chromium timing says «unknown» (-1) is not a 0 ms or -1 ms stall
    page.emit('console', { type: () => 'error', text: () => 'bad thing' });
    page.emit('console', { type: () => 'log', text: () => 'noise' });
    page.emit('pageerror', new Error('boom'));
    expect(w.records()[0]?.failure).toBe('net::ERR_ABORTED');
    expect(w.records()[0]?.stallMs).toBeNull(); // requestStart -1 = unknown
    expect(w.consoleLines().map((c) => c.text)).toEqual(['console.error', 'pageerror Error']);
  });
});

describe('담을 칸 allowlist — 서버 줄 한 줄에서 뽑는 것 (story 4927)', () => {
  it('⭐Next가 찍는 보통 줄에서 칸만 뽑는다 — 요청(하위 시간 포함) · 컴파일 · 준비 · 오류 이름 · 오류 code · ms/s 단위 통일 · 색깔 코드 제거', () => {
    expect(parseServerLine(' GET /api/activation/checklist 200 in 6.3s (compile: 6.0s, render: 300ms)')).toEqual({ kind: 'request', method: 'GET', route: '/api/activation/checklist', status: 200, ms: 6300, parts: { compile: 6000, render: 300 } });
    expect(parseServerLine(' GET / 307 in 2.7s (next.js: 2.5s, proxy.ts: 81ms, application-code: 150ms)')).toEqual({ kind: 'request', method: 'GET', route: '/', status: 307, ms: 2700, parts: { 'next.js': 2500, 'proxy.ts': 81, 'application-code': 150 } });
    expect(parseServerLine(' ○ Compiling /api/activation/checklist ...')).toEqual({ kind: 'compile', phase: 'compiling', route: '/api/activation/checklist', ms: null });
    expect(parseServerLine(' ✓ Compiled /api/activation/checklist in 6.2s (1234 modules)')).toEqual({ kind: 'compile', phase: 'compiled', route: '/api/activation/checklist', ms: 6200 });
    expect(parseServerLine(' ✓ Ready in 212ms')).toEqual({ kind: 'ready', ms: 212 });
    expect(parseServerLine(' ⨯ Error: aborted')).toEqual({ kind: 'error', name: 'Error' });
    expect(parseServerLine("  code: 'ECONNRESET'")).toEqual({ kind: 'error-code', code: 'ECONNRESET' });
    expect(parseServerLine('\u001b[32m ✓ Ready in 5ms\u001b[0m')).toEqual({ kind: 'ready', ms: 5 });
  });

  it('⭐칸이 없는 줄은 통째로 버린다(null) — 스택 줄 · 헤더 · 쿠키 · 본문 · 환경 변수 · 빈 줄 · 아무 글', () => {
    for (const line of ['', '   ', '    at ignore-listed frames', 'Authorization: Bearer abc123def456', 'cookie: sp_at=AAA', '{"password":"x"}', 'DATABASE_URL=postgresql://u:p@h/db', 'some free text', '- Local:  http://localhost:3199']) {
      expect(parseServerLine(line), line).toBeNull();
    }
  });

  it('⭐비밀이 «칸 안»에 들어가려 해도 칸이 받지 않는다 — 요청 줄의 쿼리 · URL 사용자 정보 · 토큰꼴 경로 조각 · 오류 줄의 메시지', () => {
    expect(parseServerLine('GET /api/auth/callback?token=eyJhbGciOi.AAAA.BBBB&code=SECRETCODE 200 in 4ms')).toMatchObject({ route: '/api/auth/callback' });
    expect(parseServerLine('GET https://bob:hunter-22-xyz@example.test/path?x=1 200 in 4ms')).toMatchObject({ route: '/path' });
    expect(parseServerLine('GET /verify/aGVsbG8tdG9rZW4tMTIzNDU2Nzg5 200 in 3ms')).toMatchObject({ route: '/verify/:id' });
    expect(parseServerLine('GET /api/v2/stories/0f8fad5b-d9cb-469f-a165-70867728950e 200 in 3ms')).toMatchObject({ route: '/api/v2/stories/:id' });
    const err = parseServerLine('⨯ Error: Authorization: Bearer abc123def456 and sp_rt=ROTATED777');
    expect(err).toEqual({ kind: 'error', name: 'Error' });
    expect(JSON.stringify(err)).not.toMatch(/abc123def456|ROTATED777|Bearer/);
    // an error line whose «name» is not a known one keeps no name at all
    expect(parseServerLine('⨯ Authorization: Bearer abc')).toEqual({ kind: 'error', name: 'Other' }); // not a known error name → «Other», never the word
    expect(parseServerLine('⨯ ')).toBeNull();
  });

  it('⭐normalizeRoute — pathname만(쿼리 · 조각 · 출처 · 사용자 정보 없음) · id · 토큰꼴 조각은 :id · 이상한 문자 조각은 :id · 길이 상한', () => {
    expect(normalizeRoute('http://localhost:3108/api/activation/checklist?x=1#y')).toBe('/api/activation/checklist');
    expect(normalizeRoute('https://u:p@host.test:8443/a/b')).toBe('/a/b');
    expect(normalizeRoute('/a/0f8fad5b-d9cb-469f-a165-70867728950e/tool-calls')).toBe('/a/:id/tool-calls');
    expect(normalizeRoute('/a/deadbeefdeadbeef0123')).toBe('/a/:id');
    expect(normalizeRoute('/a/123456')).toBe('/a/:id');
    expect(normalizeRoute('/a/ab12cd34ef56gh78ij90kl')).toBe('/a/:id');
    expect(normalizeRoute('/a/<script>')).toBe('/a/:id');
    expect(normalizeRoute('settings')).toBe('/settings');
    expect(normalizeRoute('/x'.repeat(200)).length).toBeLessThanOrEqual(121);
    expect(normalizeRoute('/api/activation/checklist')).toBe('/api/activation/checklist'); // an ordinary route stays readable
    expect(normalizeRoute('/content/channel-posts/nonexistent-draft-id')).toBe('/content/channel-posts/nonexistent-draft-id');
  });

  it('⭐pickAllowed — 칸의 모양이 틀리면 null · formatRecord는 한 줄 · isCompileFamily는 컴파일 기록 또는 compile 하위 시간이 있는 요청', () => {
    expect(pickAllowed({ kind: 'request', method: 'TRACE', route: '/x' })).toBeNull();
    expect(pickAllowed({ kind: 'error', name: 'has spaces' })).toEqual({ kind: 'error', name: 'Other' });
    expect(pickAllowed({ kind: 'error', name: 42 })).toBeNull();
    expect(pickAllowed({ kind: 'error-code', code: 'lower' })).toEqual({ kind: 'error-code', code: 'OTHER' });
    expect(pickAllowed({ kind: 'compile', phase: 'compiled', route: ['SECRET'], ms: 1 })).toBeNull(); // a route that is not a string is not a route
    expect(pickAllowed({ kind: 'compile', phase: 'weird', route: '/x' })).toBeNull();
    expect(pickAllowed(null)).toBeNull();
    // every kind drops any field it does not list (a message · headers · a body · the raw line)
    const extra = { message: 'LEAK-A', headers: { cookie: 'LEAK-B' }, body: 'LEAK-C', raw: 'LEAK-D' };
    for (const rec of [
      { kind: 'request', method: 'GET', route: '/x', status: 200, ms: 1, parts: {} }, { kind: 'compile', phase: 'compiled', route: '/x', ms: 1 },
      { kind: 'ready', ms: 1 }, { kind: 'error', name: 'Error' }, { kind: 'error-code', code: 'ECONNRESET' },
    ]) {
      const got = pickAllowed({ ...rec, ...extra });
      expect(got, rec.kind).not.toBeNull();
      expect(JSON.stringify(got), rec.kind).not.toMatch(/LEAK-/);
      expect(Object.keys(got!).sort(), rec.kind).toEqual(Object.keys(rec).sort());
    }
    expect(pickAllowed({ kind: 'ready', ms: 'NaN' })).toEqual({ kind: 'ready', ms: null });
    expect(formatRecord({ kind: 'error', name: 'Error' })).toBe('error Error');
    expect(formatRecord({ kind: 'error-code', code: 'ECONNRESET' })).toBe('error-code ECONNRESET');
    expect(formatRecord({ kind: 'nope' })).toBeNull();
    expect(isCompileFamily({ kind: 'compile', phase: 'compiled', route: '/x', ms: 1 })).toBe(true);
    expect(isCompileFamily({ kind: 'request', method: 'GET', route: '/x', status: 200, ms: 5, parts: { compile: 3 } })).toBe(true);
    expect(isCompileFamily({ kind: 'request', method: 'GET', route: '/x', status: 200, ms: 5, parts: { render: 3 } })).toBe(false);
  });

  it('⭐오류 이름 · 코드는 «식별자처럼 생긴 글»이 아니라 고정 목록의 것만 — 식별자 모양 비밀(TOPSECRET99)은 «Other» / «OTHER»', () => {
    expect(parseServerLine('⨯ TOPSECRET99: boom hunter2')).toEqual({ kind: 'error', name: 'Other' });
    expect(parseServerLine("  code: 'TOPSECRET_CODE_77'")).toEqual({ kind: 'error-code', code: 'OTHER' });
    expect(parseServerLine('⨯ ResponseAborted:')).toEqual({ kind: 'error', name: 'ResponseAborted' });
    expect(parseServerLine("  code: 'ECONNRESET'")).toEqual({ kind: 'error-code', code: 'ECONNRESET' });
    for (const name of ERROR_NAMES) expect(safeErrorName(name)).toBe(name);
    for (const code of ERROR_CODES) expect(safeErrorCode(code)).toBe(code);
    expect(safeErrorName('TOPSECRET99')).toBe('Other');
    expect(safeErrorName(undefined)).toBe('Other');
    expect(safeErrorCode('TOPSECRET_CODE_77')).toBe('OTHER');
    expect(formatRecord({ kind: 'error', name: 'TOPSECRET99' })).toBe('error Other');
  });

  it('⭐경로가 아닌 URL(data: · blob: · javascript: · about: · mailto:)은 몸통을 안 담는다 — 스킴 이름뿐', () => {
    expect(normalizeRoute('data:text/plain,SECRET')).toBe('/(data)');
    expect(normalizeRoute('blob:http://localhost:3108/0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('/(blob)');
    expect(normalizeRoute('javascript:alert(document.cookie)')).toBe('/(javascript)');
    expect(normalizeRoute('about:blank')).toBe('/(about)');
    expect(normalizeRoute('mailto:a@b.c?subject=SECRET')).toBe('/(mailto)');
    expect(normalizeRoute('/a:b/c')).toBe('/a:b/c'); // a colon inside a path is still a path
    expect(JSON.stringify([normalizeRoute('data:text/plain,SECRET')])).not.toContain('SECRET');
  });

  it('⭐브라우저 쪽 값도 고정 목록 · 요청 방법 · 자원 종류 · 실패 코드 · 문서 상태 — 목록 밖은 비밀 모양이어도 OTHER/other/net::ERR_OTHER/?', () => {
    expect(safeMethod('TOPSECRET99')).toBe('OTHER');
    expect(safeMethod('get')).toBe('GET');
    expect(safeMethod(undefined)).toBe('OTHER');
    expect(safeResourceType('TOPSECRET99')).toBe('other');
    expect(safeResourceType('eventsource')).toBe('eventsource');
    expect(safeNetError('net::ERR_TOPSECRET99')).toBe('net::ERR_OTHER');
    expect(safeNetError('net::ERR_ABORTED')).toBe('net::ERR_ABORTED');
    expect(safeNetError('')).toBeNull();
    expect(safeReadyState('TOPSECRET99')).toBe('?');
    expect(safeReadyState('interactive')).toBe('interactive');
    for (const m of HTTP_METHODS) expect(safeMethod(m)).toBe(m);
    for (const t of RESOURCE_TYPES) expect(safeResourceType(t)).toBe(t);
    for (const e of NET_ERRORS) expect(safeNetError(e)).toBe(e);
    for (const r of DOC_READY_STATES) expect(safeReadyState(r)).toBe(r);
  });

  it('⭐watchNetwork는 요청 방법 · 자원 종류를 목록으로 걸러 담는다 — 비밀 모양 방법(TOPSECRET99) · 종류가 보고서까지 못 감', () => {
    const page = new EventEmitter();
    const w = watchNetwork(page as never);
    page.emit('request', { url: () => 'http://localhost:3108/x', method: () => 'TOPSECRET99', resourceType: () => 'TOPSECRET88', timing: () => ({ requestStart: -1 }), failure: () => null });
    expect(w.records()[0]).toMatchObject({ method: 'OTHER', resourceType: 'other' });
    const text = formatMarkerReport(input({ records: [{ ...w.records()[0]!, requestAt: RELOAD + 5 }] }));
    expect(text).not.toMatch(/TOPSECRET/);
  });

  it('⭐프로토콜 상대 URL(//user:pass@host/path)도 권한 부분을 버린다', () => {
    expect(normalizeRoute('//bob:secret-pass-1@host.test:8080/a/b?x=1')).toBe('/a/b');
    expect(normalizeRoute('//cdn.example.test/lib.js')).toBe('/lib.js');
    expect(parseServerLine('GET //bob:secret-pass-1@host/p 200 in 1ms')).toMatchObject({ route: '/p' });
  });

  it('⭐서버 기록 창의 끝은 보고서가 끝난 때(endAt) — 늦게 지켜본 시간(lateWatchMs)과 별개', () => {
    const rec1 = { at: TIMED_OUT + 3000, rec: { kind: 'ready' as const, ms: 1 } };
    const withEnd = formatMarkerReport(input({ serverLines: [rec1], lateWatchMs: 0, endAt: TIMED_OUT + 4000 }));
    expect(withEnd).toContain('ready 1ms');
    const withoutEnd = formatMarkerReport(input({ serverLines: [rec1], lateWatchMs: 0 }));
    expect(withoutEnd).not.toContain('ready 1ms'); // default end = timedOutAt + lateWatchMs
  });

  it('safeFailure — Chromium 실패 코드(net::ERR_*)만 그대로, 그 밖은 «failed»', () => {
    expect(safeFailure('net::ERR_ABORTED')).toBe('net::ERR_ABORTED');
    expect(safeFailure('net::ERR_CONNECTION_REFUSED at http://u:p@h/')).toBe('net::ERR_OTHER');
    expect(safeFailure('net::ERR_TOPSECRET99')).toBe('net::ERR_OTHER'); // looks like a code, is not one of the known ones
    expect(safeFailure('')).toBeNull();
    expect(safeFailure(undefined)).toBeNull();
  });
});

describe('더 지켜보기는 시험의 첫 시도에서만 (story 4927 · PO 11-14)', () => {
  it('⭐재시도(retry>0)는 0 — 첫 시도만 최대 maxMs까지, 시험 예산(시간 한도 − 지난 시간 − 여유 8초) 안에서', () => {
    const base = { testTimeoutMs: 30_000, elapsedMs: 8_000, maxMs: 12_000 };
    expect(lateWatchBudgetMs({ ...base, retry: 0 })).toBe(12_000); // 30 − 8 − 8 = 14 s left → capped at maxMs
    expect(lateWatchBudgetMs({ ...base, retry: 1 })).toBe(0);
    expect(lateWatchBudgetMs({ ...base, retry: 2 })).toBe(0);
    expect(lateWatchBudgetMs({ ...base, retry: 0, elapsedMs: 20_000 })).toBe(2_000); // 30 − 20 − 8
    expect(lateWatchBudgetMs({ ...base, retry: 0, elapsedMs: 25_000 })).toBe(0); // never negative
    expect(lateWatchBudgetMs({ ...base, retry: 0, elapsedMs: 20_000, marginMs: 4_000 })).toBe(6_000); // an explicit margin
  });

  it('⭐최악 더 지켜보기 시간 = 첫 시도 놓침 수 × 12초 — 25분 잡 상한과 견준 숫자(PR 본문)', () => {
    const maxMs = 12_000;
    const worst = (firstAttemptMisses: number) => firstAttemptMisses * lateWatchBudgetMs({ retry: 0, testTimeoutMs: 30_000, elapsedMs: 0, maxMs });
    expect(worst(17)).toBe(204_000); // the 5781 CI run had 17 first-attempt misses: 3.4 min at worst (was 33 misses × 12 s = 6.6 min)
    expect(worst(28)).toBe(336_000); // all 28 contrast tests missing on the first attempt: 5.6 min — inside the 25 min job limit
    const everyAttempt = (attempts: number) => attempts * maxMs;
    expect(everyAttempt(33)).toBe(396_000);
  });

  it('⭐보고서는 재시도라 안 지켜봤다고 적는다(0ms가 «아무것도 안 왔다»로 읽히지 않게)', () => {
    expect(formatMarkerReport(input({ lateWatchSkipped: true }))).toContain('(재시도라 안 지켜봄 — 첫 시도에서만 지켜봄)');
    expect(formatMarkerReport(input({ lateWatchSkipped: false }))).not.toContain('안 지켜봄');
    expect(formatMarkerReport(input({}))).not.toContain('안 지켜봄');
  });
});

describe('서버 줄 파일은 끝 2MB만 읽는다 (story 4927)', () => {
  it('⭐2MB보다 큰 파일이면 앞쪽은 버리고 · 잘린 첫 줄도 버리고 · 끝쪽 줄을 읽는다(한 CI 잡이 여러 e2e 단계를 같은 파일에 이어 씀) · 파일 없으면 available=false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tail4927-'));
    const file = join(dir, 'next-dev.log');
    const filler = `1000\t{"kind":"ready","ms":1000}\n`;
    const L = Buffer.byteLength(filler);
    const count = Math.ceil(MAX_LOG_TAIL_BYTES / L) + 50;
    // pad the last record so the 2 MB tail starts exactly 2 bytes into a filler line («10|00\t{…»): a kept half line would parse as a bogus {at: 0}
    const lastBase = Buffer.byteLength('9999\t{"kind":"ready","ms":9999}\n');
    const pad = (((2 + MAX_LOG_TAIL_BYTES - lastBase) % L) + L) % L;
    writeFileSync(file, `1\t{"kind":"ready","ms":1}\n${filler.repeat(count)}9999\t{"kind":"ready","ms":9999}${' '.repeat(pad)}\n`);
    const got = readServerLog(file);
    rmSync(dir, { recursive: true, force: true });
    expect(got.available).toBe(true);
    expect(got.lines.some((l) => l.at === 1)).toBe(false);
    expect(got.lines[got.lines.length - 1]).toEqual({ at: 9999, rec: { kind: 'ready', ms: 9999 } });
    expect(got.lines.length).toBeLessThan(count); // part of it was dropped
    expect(got.lines.every((l) => l.at === 1000 || l.at === 9999)).toBe(true); // and no half line was read as one
    expect(readServerLog(join(dir, 'gone.log')).available).toBe(false);
    expect(readServerLog(undefined).available).toBe(false);
  });
});

describe('서버 줄을 칸만 담는 껍데기 (story 4927)', () => {
  const wrapper = join(WEB, 'e2e/support/dev-server-logged.mjs');
  function run(cmd: string, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'wrap4927-'));
    const file = join(dir, 'nested', 'next-dev.log');
    const r = spawnSync(process.execPath, [wrapper], { env: { ...process.env, E2E_WEBSERVER_LOG: file, E2E_DEV_SERVER_CMD: cmd, ...env }, encoding: 'utf8', timeout: 20_000 });
    let logged = '';
    try { logged = readFileSync(file, 'utf8'); } catch { /* none */ }
    rmSync(dir, { recursive: true, force: true });
    return { r, logged };
  }

  it('⭐stdout · stderr 줄에서 칸만 뽑아 시각과 함께 파일에 남기고(폴더도 만든다) stdout에도 한 줄 형태로 내보낸다 — 칸 없는 줄은 어디에도 안 나감', () => {
    const { r, logged } = run("printf ' GET /x 200 in 5ms\\n ✓ Compiled /y in 1.5s\\nsome raw text\\n'; echo ' ⨯ ResponseAborted: secret message' 1>&2");
    expect(r.status).toBe(0);
    const lines = parseServerLog(logged);
    expect(lines.map((l) => formatRecord(l.rec))).toEqual(expect.arrayContaining(['request GET /x 200 5ms', 'compile compiled /y 1500ms', 'error ResponseAborted']));
    for (const l of lines) expect(l.at).toBeGreaterThan(1_700_000_000_000);
    expect(r.stdout).toMatch(/\[next \d\d:\d\d:\d\d\.\d{3}\] request GET \/x 200 5ms/);
    for (const raw of ['some raw text', 'secret message']) { expect(logged).not.toContain(raw); expect(r.stdout).not.toContain(raw); }
    expect(logged.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('⭐끝 줄바꿈 없는 마지막 줄도 잃지 않고, 자식의 종료 코드를 그대로 낸다', () => {
    const { r, logged } = run("printf ' ✓ Ready in 9ms'; exit 7");
    expect(r.status).toBe(7);
    expect(parseServerLog(logged).map((l) => formatRecord(l.rec))).toEqual(['ready 9ms']);
  });

  it('⭐알려진 비밀 꼴 전부를 자식이 일부러 흘려도 파일 · stdout에 0 — JWT · Bearer · 쿠키 · Set-Cookie · URL user:password(빈 사용자명 포함) · PEM 여러 줄 · 따옴표 없는/있는 키 · 환경변수 값 · 요청 줄의 쿼리 · 오류 메시지', () => {
    const secrets = [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz', 'abc123def456', 'TOPSECRET99', 'ZZZ999YYY', 'db-pass-4242', 'empty-user-pass-5', 'hunter-22-xyz',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'unquoted-key-token-3', 'quoted-key-token-4', 'wrapper-test-secret-value-0001', 'QUERYSECRET1', 'ERRMSGSECRET2', 'COOKIEVAL3', 'IDSHAPEDSECRET7', 'CODESHAPEDSECRET8',
    ];
    const shell = [
      'echo "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz"',
      'echo "Authorization: Bearer abc123def456"',
      'echo "cookie: sp_at=TOPSECRET99; theme=COOKIEVAL3"',
      'echo "set-cookie: sp_rt=ZZZ999YYY; Path=/"',
      'echo "connect postgresql+asyncpg://sprintable:db-pass-4242@localhost:5432/app"',
      'echo "redis://:empty-user-pass-5@cache.internal:6379 and https://bob:hunter-22-xyz@example.test/p"',
      'echo "-----BEGIN PRIVATE KEY-----"; echo "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"; echo "-----END PRIVATE KEY-----"',
      "echo \"{ sp_rt: 'unquoted-key-token-3' }\"; echo '{\"sp_at\":\"quoted-key-token-4\"}'",
      'echo "JWT_SECRET is wrapper-test-secret-value-0001"',
      'echo " GET /api/auth/callback?token=QUERYSECRET1 200 in 4ms"',
      'echo " ⨯ Error: ERRMSGSECRET2 Authorization: Bearer abc123def456"',
      'echo " ⨯ IDSHAPEDSECRET7: boom"',
      "echo \"  code: 'CODESHAPEDSECRET8'\"",
      'echo " ✓ Compiled /api/activation/checklist in 6.2s"',
    ].join('; ');
    const { r, logged } = run(shell, { JWT_SECRET: 'wrapper-test-secret-value-0001' });
    expect(r.status).toBe(0);
    for (const secret of secrets) {
      expect(logged, secret).not.toContain(secret);
      expect(r.stdout, secret).not.toContain(secret);
    }
    // the allowed fields of the lines that had some survive: the compile time, the request route without its query, the error name without its message
    const kept = parseServerLog(logged).map((l) => formatRecord(l.rec));
    expect(kept).toEqual(['request GET /api/auth/callback 200 4ms', 'error Error', 'error Other', 'error-code OTHER', 'compile compiled /api/activation/checklist 6200ms']);
  });

  it('로그 경로가 없으면 파일 없이도 돈다(stdout만 — 칸이 있는 줄만)', () => {
    const r = spawnSync(process.execPath, [wrapper], { env: { ...process.env, E2E_WEBSERVER_LOG: '', E2E_DEV_SERVER_CMD: "printf ' ✓ Ready in 3ms\\nraw\\n'" }, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ready 3ms');
    expect(r.stdout).not.toContain('raw');
  });
});

describe('진단 파일은 «읽지 않는 것»을 소스로 못 박는다 (story 4927)', () => {
  const files = ['marker-diagnostics.ts', 'marker-wait.ts', 'dev-server-logged.mjs', 'server-line-allowlist.mjs'].map((f) => [f, readFileSync(join(WEB, 'e2e/support', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')] as const);

  it('⭐헤더 · 쿠키 · 본문 · 오류 메시지 · 콘솔 글 · 전체 URL 문자열 읽기가 소스에 없다 — 담을 칸이 없다', () => {
    const forbidden = [/\.headers?\(/, /\.allHeaders\(/, /\.headersArray\(/, /\.postData\(/, /\.postDataBuffer\(/, /\.cookies\(/, /\.body\(\)/, /\.text\(\)/, /\.json\(\)/, /\berr(?:or)?\.message\b/, /\be\.message\b/, /\.stack\b/];
    for (const [name, src] of files) for (const re of forbidden) expect(src, `${name} ${re}`).not.toMatch(re);
  });

  it('⭐가림 모듈(redact)은 없다 — 가릴 목록이 아니라 담을 칸 목록', () => {
    for (const [name, src] of files) expect(src, name).not.toMatch(/redact/i);
    expect(() => readFileSync(join(WEB, 'e2e/support/redact-server-line.mjs'), 'utf8')).toThrow();
  });

  it('⭐서버 원문 줄을 파일 · stdout에 쓰는 자리가 없다 — 껍데기는 파싱한 기록(rec)만 쓴다', () => {
    const wrapper = files.find(([n]) => n === 'dev-server-logged.mjs')![1];
    expect(wrapper).toContain('JSON.stringify(rec)');
    expect(wrapper).toContain('formatRecord(rec)');
    expect(wrapper).not.toMatch(/appendFileSync\([^)]*\b(text|raw|line)\b/);
    expect(wrapper).not.toMatch(/stdout\.write\([^)]*\b(text|raw)\b/);
  });
});

describe('스펙 · 설정이 진단에 연결돼 있다 (story 4927)', () => {
  const spec = readFileSync(join(WEB, 'e2e/contrast-guard.spec.ts'), 'utf8');
  const config = readFileSync(join(WEB, 'playwright.config.ts'), 'utf8');
  const ci = readFileSync(join(WEB, '..', '..', '.github/workflows/ci.yml'), 'utf8');

  const wait = readFileSync(join(WEB, 'e2e/support/marker-wait.ts'), 'utf8');

  it('⭐한도 5000 · 던지는 첫 줄 · 던지기 前 진단 호출 — 재시도 · 시간 늘리기 · 삼키기 0', () => {
    expect(wait).toContain('export const PAGE_MARKER_TIMEOUT_MS = 5000;');
    expect(wait).toContain("const timeoutMs = options.timeoutMs ?? PAGE_MARKER_TIMEOUT_MS;");
    expect(wait).toContain('throw new Error(`contrast-guard precondition: page marker not seen — ${pagePath} ${markerDesc} within ${timeoutMs}ms\\n${report}`);');
    expect(wait.indexOf('await safeReport(')).toBeGreaterThan(0);
    expect(wait.indexOf('await safeReport(')).toBeLessThan(wait.indexOf('throw new Error(`contrast-guard precondition'));
    // no new way past a miss in the marker wait
    const body = wait.slice(wait.indexOf('export async function waitForPageMarker('));
    for (const bad of ['retry', 'test.skip', 'test.fixme', 'test.slow', 'return;']) expect(body, bad).not.toContain(bad);
    expect(config).toContain("retries: process.env['CI'] ? 2 : 0");
  });

  it('⭐스펙은 그 대기를 쓰고(제 사본을 안 가짐) 시험마다 관찰을 건다 · 옛 문서의 열린 스트림도 보이게 첫 goto 前에 붙는다', () => {
    expect(spec).toContain("import { installMarkerWatch, waitForPageMarker, type PageWaitMarker } from './support/marker-wait';");
    expect(spec).toContain('installMarkerWatch();');
    expect(spec).toContain('await waitForPageMarker(page, marker, pagePath);');
    expect(spec).not.toContain('async function waitForPageMarker');
    expect(spec).not.toContain('PAGE_MARKER_TIMEOUT_MS');
    expect(wait).toContain('test.beforeEach(({ page }) => { WATCHES.set(page, { watch: watchNetwork(page), startedAt: Date.now() }); });');
    // a TestInfo field that does not exist (startTime) made the first version throw while building the report
    expect(wait).not.toContain('startTime');
  });

  it('⭐페이지 상태의 path는 pathname을 normalizeRoute로 거친 것 · 진단 실패 줄은 오류 이름만', () => {
    expect(wait).toContain('normalizeRoute(d.path)');
    expect(wait).toContain('lateWatchBudgetMs({ retry: info.retry,');
    expect(wait).toContain('lateWatchSkipped: info.retry > 0,');
    expect(wait).toContain('readyState=${safeReadyState(d.readyState)}');
    expect(wait).toContain("safeErrorName(e instanceof Error ? e.name : '')");
  });

  it('⭐진단이 스스로 터져도 원래 오류를 가리지 않는다(safeReport) — 진단 실패 줄만 대신 싣는다', () => {
    expect(wait).toContain('async function safeReport(');
    expect(wait).toContain('── 진단 만들기 실패 (story 4927) ──');
  });

  it('⭐실패 때 올리는 artifact의 `path:`는 정확히 두 폴더(playwright-report · server-logs) — 로그인 상태(`playwright/.auth/`) · 그 밖의 어떤 경로도 못 얹는다(카디르 렌즈: 변이가 살아남았던 자리)', () => {
    const at = ci.indexOf('- name: Upload Playwright report');
    expect(at).toBeGreaterThan(0);
    const step = ci.slice(at, ci.indexOf('\n\n', at) > 0 ? ci.indexOf('\n\n', at) : undefined);
    expect(ci.split('- name: Upload Playwright report').length - 1).toBe(1); // one such step
    const block = /path: \|\n((?:\s+\S.*\n?)+)/.exec(step);
    expect(block, 'the upload path is a two-line block').not.toBeNull();
    const paths = block![1]!.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^(retention-days|if-no-files-found|name|uses|with|if):/.test(l));
    expect(paths.slice(0, 2)).toEqual(['apps/web/playwright-report/', 'apps/web/playwright/server-logs/']);
    expect(paths).toHaveLength(2);
    expect(step).not.toMatch(/\.auth|storageState|owner\.json/);
    expect(step).not.toMatch(/include-hidden-files/); // no hidden file goes up by switch either
  });

  it('⭐CI 잡(contrast-guard-e2e)의 웹 e2e는 전부 프로덕션 빌드 한 번 + `next start` 위에서 돈다 — 빌드 1 · 서버 → 대비 → 카드 면 → 모바일 폭 → 데스크톱 설정 → 서버 끔 → (v3 플래그 서버 → v3 좁은 폭 → 끔) · 스텝마다 PLAYWRIGHT_BASE_URL · `pnpm dev` 0 (story 4927)', () => {
    const start = ci.indexOf('\n  contrast-guard-e2e:');
    expect(start).toBeGreaterThan(0);
    const after = ci.slice(start + 1);
    const nextJob = after.search(/\n  [a-z0-9-]+:\n/);
    const job = nextJob > 0 ? after.slice(0, nextJob) : after;
    const steps = job.split('\n      - name:').slice(1).map((chunk) => '- name:' + chunk);
    const at = (needle: string) => steps.findIndex((st) => st.startsWith(`- name: ${needle}`) || st.startsWith(`- name: "${needle}`));
    const order = ['Run layout e2e', 'Build web (production', 'Start production server (next start', 'Run contrast-guard e2e', 'Run card-surface e2e', 'Run mobile-width overflow e2e', 'Run desktop setup', 'Stop production server\n', 'Start production server with the v3 flags', 'Run v3 narrow-width overflow e2e', 'Stop production server (v3 flags)'];
    const idx = order.map((n) => (n.endsWith('\n') ? steps.findIndex((st) => st.startsWith('- name: Stop production server\n')) : at(n)));
    order.forEach((n, i) => expect(idx[i], `step «${n.trim()}» exists`).toBeGreaterThanOrEqual(0));
    for (let i = 1; i < idx.length; i += 1) expect(idx[i], `«${order[i].trim()}» comes after «${order[i - 1].trim()}»`).toBeGreaterThan(idx[i - 1]);
    // one production build in the job (the step before the contrast guard) — no second build, no dev server
    const code = job.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // the comments may name `pnpm dev` (they say why it is gone)
    expect(code.split('pnpm --filter web build').length - 1).toBe(1);
    expect(code).not.toMatch(/pnpm dev|next dev/);
    // every e2e step that talks to the app uses the server that is already up
    for (const name of ['Run contrast-guard e2e', 'Run card-surface e2e', 'Run mobile-width overflow e2e', 'Run desktop setup', 'Run v3 narrow-width overflow e2e']) {
      expect(steps[at(name)], name).toContain('PLAYWRIGHT_BASE_URL: http://localhost:3108');
    }
    // the v3 flags live on the SECOND server only (the first one — and so contrast · card-surface · mobile-width — runs with them OFF)
    const first = steps[at('Start production server (next start')];
    const v3 = steps[at('Start production server with the v3 flags')];
    for (const flag of ['TODAY_V3_ENABLED', 'CHAT_V3_ENABLED', 'CONNECT_RULES_V3_ENABLED']) {
      expect(first, `first server has no ${flag}`).not.toContain(flag);
      expect(v3, `v3 server has ${flag}`).toContain(`${flag}: 'true'`);
      expect(code.split(flag).length - 1, `${flag} appears once in the job's steps (the v3 server)`).toBe(1);
    }
    expect(steps[at('Run v3 narrow-width overflow e2e')]).not.toContain('TODAY_V3_ENABLED: ');
    // the stop steps run even when an e2e step failed
    expect(steps.find((st) => st.startsWith('- name: Stop production server\n'))).toContain('if: always()');
    expect(steps[at('Stop production server (v3 flags)')]).toContain('if: always()');
    // the stop is by the LISTENing socket (pnpm exec's pid is not the server's) and the port must be free before the second server binds it
    const stop1 = steps.find((st) => st.startsWith('- name: Stop production server\n'))!;
    expect(stop1).toContain('bash apps/web/scripts/kill-port.sh 3108');
    expect(stop1).toMatch(/if lsof -ti tcp:3108 -sTCP:LISTEN[^\n]*; then echo [^\n]*exit 1; fi/);
    expect(stop1).not.toMatch(/kill "\$\(cat \/tmp\/next-start\.pid/);
    expect(v3).toMatch(/if lsof -ti tcp:3108 -sTCP:LISTEN[^\n]*; then echo [^\n]*exit 1; fi\n\s+nohup pnpm exec next start/);
    expect(steps[at('Stop production server (v3 flags)')]).toContain('bash apps/web/scripts/kill-port.sh 3108');
    // the marker wait stays 5000 ms: a flake is not covered with time (PO)
    expect(wait).toContain('export const PAGE_MARKER_TIMEOUT_MS = 5000;');
  });

  it('⭐서버 껍데기는 CI 기본 꺼짐(E2E_SERVER_LOG=1일 때만) — 꺼짐일 때 webServer는 develop과 같은 `pnpm dev` · 키 집합까지 같음 · 켜짐이면 껍데기 + pipe', async () => {
    const load = async (env: Record<string, string | undefined>) => {
      const keys = ['E2E_SERVER_LOG', 'E2E_WEBSERVER_LOG', 'PLAYWRIGHT_BASE_URL', 'CI'];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      try {
        for (const k of keys) delete process.env[k];
        for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
        vi.resetModules();
        const mod = await import('../../playwright.config');
        return { cfg: mod.default as { webServer?: Record<string, unknown> }, logPath: process.env['E2E_WEBSERVER_LOG'] };
      } finally {
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      }
    };
    // develop's webServer, letter for letter: command · url · reuseExistingServer — nothing else (no stdout / stderr keys)
    for (const env of [{ CI: '1' }, {}, { CI: '1', E2E_SERVER_LOG: '0' }]) {
      const off = await load(env);
      expect(off.cfg.webServer, JSON.stringify(env)).toStrictEqual({ command: 'pnpm dev', url: 'http://localhost:3108', reuseExistingServer: !env.CI });
      expect(Object.keys(off.cfg.webServer!)).toEqual(['command', 'url', 'reuseExistingServer']);
      expect(off.logPath, 'no log path is exported while the switch is off').toBeUndefined();
    }
    const on = await load({ CI: '1', E2E_SERVER_LOG: '1' });
    expect(on.cfg.webServer).toMatchObject({ command: 'node e2e/support/dev-server-logged.mjs', stdout: 'pipe', stderr: 'pipe' });
    expect(on.logPath).toContain('playwright/server-logs/next-dev.log');
    // the source says why it is off, with the measured numbers
    expect(config).toContain("process.env['E2E_SERVER_LOG'] === '1'");
    expect(config).toContain('wrapper only: 1 failed');
    // upload-artifact@v4 skips hidden files by default: a «.logs» directory would upload nothing and the step would still be green — so the directory is not hidden
    expect(ci).toContain('apps/web/playwright/server-logs/');
    expect(ci).not.toContain('playwright/.logs');
    expect(config).toContain('playwright/server-logs/next-dev.log');
    expect(readFileSync(join(WEB, '.gitignore'), 'utf8')).toContain('/playwright/server-logs');
  });
});
