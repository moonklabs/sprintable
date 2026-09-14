/**
 * story #3857 회귀가드(AC3, 「클래스 닫기」) — BE 라우터가 목록 페이지네이션 신호를
 * X-Total-Count·X-Next-Cursor 응답 헤더로만 내는 자리(#2190 board 분기·#3705/#3744/#3761
 * 계열과 동형)에서, 그 헤더를 실제로 소비하는 FE 프록시가 조용히 버리면(구 agent-runs·
 * standup·sprints·retro-sessions — apiSuccess(await _r.json())로 body만 취함) "한 페이지가
 * 전체"로 단정하는 결함 클래스(#4049/#4052/#4054와 동형)가 재발한다.
 *
 * 이 가드는 두 축을 고정한다:
 *   ① baseline sync(stale fail-closed) — `backend/app/routers/`에서 그 헤더를 내는 라우터
 *      파일 목록을 실측하고, 미르코 그라운딩(story #3857, 2026-09-14 08:05Z)이 확定한
 *      baseline 10개와 정확히 일치하는지 본다. 새 라우터가 헤더를 내기 시작하면(또는 기존
 *      라우터가 그만두면) 이 baseline이 stale해져 이 테스트부터 RED — 사람이 PROXY_MAP도
 *      함께 갱신하도록 강제한다(조용히 지나가는 「baseline만 낡고 아무도 안 알아챔」을 차단).
 *   ② FE 소비 대조 — PROXY_MAP에 등재된 각 BE 자원의 FE 프록시 파일이 실제로 존재하고,
 *      x-total-count·x-next-cursor·buildCursorPageMeta 중 하나 이상을 소스에 담고 있는지
 *      본다(「버림」 패턴 apiSuccess(await _r.json())만 있고 헤더를 읽는 흔적이 전혀 없으면
 *      FAIL). `events`는 그 자원의 헤더 발신 엔드포인트(GET /api/v2/events/pending)를 아직
 *      아무 FE 프록시도 안 쓴다는 것이 그라운딩 결론이라 PROXY_MAP에 `null`로 명시(「버림」이
 *      아니라 「프록시 자체 없음」) — 그 전제가 깨지면(누군가 나중에 그 엔드포인트를 FE에서
 *      호출하기 시작하면) `findUnexpectedEventsProxy`가 그 자리에서 잡는다.
 *   ③ BE 기본 limit ↔ FE 기본값 상수 동기화(PO CHANGES②, 2026-09-14 09:01Z) — direct-proxy
 *      4곳(agent-runs·standup·sprints·retro-sessions route.ts)의 `Number(...) || N` 폴백
 *      상수 N은 그 BE 라우터의 `Query(default=N)`을 그대로 복제한 값이다(BE가 limit을
 *      안 받았을 때 실제로 적용하는 기본값과 FE가 "꽉 찬 페이지" 판정에 쓰는 requestedLimit이
 *      어긋나면 안 됨). BE 기본값이 바뀌는데 FE 상수가 안 따라가면 조용히 다시 「한 페이지=
 *      전체」로 돌아간다 — LIMIT_DEFAULT_RESOURCES 4개를 실측 대조(stale fail-closed).
 *      BE `Query(default=None)`(sprints·retros — 리터럴 기본값이 라우터 시그니처에 없다)은
 *      숫자 대조 대상이 아니라고 명시(스킵이 아니라 「None임을 확인」까지 검사 — extractBe
 *      LimitDefault가 `undefined`(패턴을 못 찾음, 가드 stale)와 `null`(찾았는데 값이 None)을
 *      구분한다).
 *
 * ── 스코프 밖(이 가드가 못 잡는 것) ─────────────────────────────────────────
 *   ㉠ 시그널 검사(②)는 "파일이 그 문자열을 담고 있는가"라는 존재 검사다 — 실제로 그
 *      값이 응답 meta로 올바르게 재발행되는지(계산이 맞는지)는 각 라우트의 route.test.ts
 *      (agent-runs/standup/retro-sessions/sprints route.test.ts, story #3857 AC1)가 담당.
 *      이 가드는 "완전히 버려지는 새 회귀"만 잡는 얕고 넓은 그물이다.
 *   ㉡ (뮤테이션 검증 中 실측, 2026-09-14) — 헤더 읽기 코드를 지우지 않고 그 앞에
 *      `return apiSuccess(data)`만 끼워 넣어 이후 코드를 도달불능(dead code)으로 만드는
 *      경우, 문자열 `x-total-count` 등은 파일에 여전히 남아 있어 이 정적 시그널 검사를
 *      못 속인다(TypeScript면 `no-unreachable`/dead-code 린트가 별도로 잡을 자리 — 이
 *      가드의 책임 밖). 실제 revert(코드를 지우는 정상적인 회귀)는 문자열 자체가 사라지므로
 *      정상 탐지된다 — 위 예시는 이 가드를 우회하려는 의도적 시도에만 뚫리는 인위적 경로다.
 *   ㉢ BE 라우터 파일이 여러 GET 엔드포인트를 가질 때(예: agent_runs.py의 list_agent_runs +
 *      tool-calls) 파일 단위로만 대조한다 — PROXY_MAP 값은 그 파일이 내는 "어떤" 헤더든
 *      하나 이상 실제로 읽는 FE 프록시 목록이면 통과, 엔드포인트별 1:1 정합은 안 본다.
 *   ㉣ ③(limit 기본값 대조)은 `Number(searchParams.get('limit')) || N` 리터럴 형만 인식한다
 *      (정규식 기반) — 이 표현을 다른 형태로 리팩터하면 추출 자체가 실패해 "패턴을 못 찾음"
 *      violation으로 FAIL한다(값이 몰래 틀려지는 것보다 안전한 실패 — stale fail-closed).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROUTERS_DIR = path.resolve(SCRIPT_DIR, '../../../backend/app/routers');
const API_DIR = path.resolve(SCRIPT_DIR, '../src/app/api');

const HEADER_EMIT_RE = /response\.headers\["X-(Total-Count|Next-Cursor)"\]\s*=/;

// 미르코 그라운딩(story #3857, 2026-09-14 08:05Z) 확定값. 바뀌면(늘거나 줄면) ①이 RED —
// PROXY_MAP도 함께 갱신할 것(늘어난 자원은 FE 소비처를 새로 매핑, 줄어든 자원은 걷어낸다).
export const FROZEN_BE_HEADER_ROUTERS = [
  'agent_runs', 'channel_posts', 'events', 'goals', 'retros',
  'site_posts', 'sprints', 'standups', 'stories', 'tasks',
].sort();

// BE 자원 → FE 프록시(src/app/api 기준 상대경로) 목록. null = 그 자원의 헤더 발신
// 엔드포인트를 아직 어떤 FE 프록시도 안 쓴다(「버림」이 아니라 「프록시 없음」, events만 해당).
export const PROXY_MAP: Record<string, string[] | null> = {
  agent_runs: ['agent-runs/route.ts', 'v1/agent-runs/[id]/tool-calls/route.ts'],
  channel_posts: ['organizations/[id]/channel-posts/drafts/route.ts'],
  events: null,
  goals: ['goals/route.ts'],
  retros: ['retro-sessions/route.ts'],
  site_posts: ['organizations/[id]/site-posts/drafts/route.ts'],
  sprints: ['sprints/route.ts'],
  standups: ['standup/route.ts'],
  stories: ['stories/route.ts', 'stories/backlog/route.ts'],
  tasks: ['tasks/route.ts'],
};

// events.py의 헤더 발신 엔드포인트(list_pending_events, GET /pending) 실제 업스트림 경로.
// PROXY_MAP.events가 null인 전제 — 이 문자열을 쓰는 FE 프록시가 하나라도 생기면 그 전제가
// 깨진 것이므로 findUnexpectedEventsProxy가 그 파일을 지목해 FAIL한다.
export const EVENTS_PENDING_UPSTREAM = '/api/v2/events/pending';

const META_SIGNAL_RE = /x-total-count|x-next-cursor|buildCursorPageMeta/i;

export function listBeHeaderRouters(routersDir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(routersDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.py')) continue;
    const content = readFileSync(path.join(routersDir, entry.name), 'utf8');
    if (HEADER_EMIT_RE.test(content)) names.push(entry.name.replace(/\.py$/, ''));
  }
  return names.sort();
}

export function findMissingMetaSignal(apiDir: string, proxyMap: Record<string, string[] | null>): string[] {
  const violations: string[] = [];
  for (const [resource, proxies] of Object.entries(proxyMap)) {
    if (proxies === null) continue;
    for (const rel of proxies) {
      const full = path.join(apiDir, rel);
      let content: string;
      try {
        content = readFileSync(full, 'utf8');
      } catch {
        violations.push(`${resource}: 프록시 파일을 못 찾음 — ${rel}(경로 변경/삭제됐으면 PROXY_MAP도 갱신할 것)`);
        continue;
      }
      if (!META_SIGNAL_RE.test(content)) {
        violations.push(`${resource}: ${rel}가 x-total-count·x-next-cursor·buildCursorPageMeta 중 어느 것도 안 읽음(헤더를 버리는 회귀로 보임)`);
      }
    }
  }
  return violations;
}

// PO CHANGES②(2026-09-14 09:01Z) — direct-proxy 4곳의 BE 라우터 파일 ↔ FE 프록시 파일 매핑.
// PROXY_MAP과 별개 표인 이유: PROXY_MAP은 "헤더를 읽는가"(존재 검사, 여러 파일 허용)를 보고,
// 이 표는 "기본 limit 숫자가 일치하는가"(정확한 값 대조, 단일 파일)를 본다 — direct-proxy
// 패턴(Number(...) || N)을 쓰지 않는 나머지 6개 자원(parseCursorPageInput류 다른 메커니즘)은
// 대상이 아니다.
export const LIMIT_DEFAULT_RESOURCES: Record<string, { beFile: string; feFile: string }> = {
  agent_runs: { beFile: 'agent_runs.py', feFile: 'agent-runs/route.ts' },
  standups: { beFile: 'standups.py', feFile: 'standup/route.ts' },
  sprints: { beFile: 'sprints.py', feFile: 'sprints/route.ts' },
  retros: { beFile: 'retros.py', feFile: 'retro-sessions/route.ts' },
};

const BE_LIMIT_DEFAULT_RE = /limit:\s*int(?:\s*\|\s*None)?\s*=\s*Query\(\s*default=(None|\d+)/;
const FE_LIMIT_DEFAULT_RE = /requestedLimit\s*=\s*Number\(searchParams\.get\('limit'\)\)\s*\|\|\s*(\d+)/;

/** BE Query(default=N|None)를 추출. undefined = 패턴 자체를 못 찾음(가드 stale, 값 문제 아님). */
export function extractBeLimitDefault(routerContent: string): number | null | undefined {
  const m = routerContent.match(BE_LIMIT_DEFAULT_RE);
  if (!m) return undefined;
  return m[1] === 'None' ? null : Number(m[1]);
}

/** FE `|| N` 폴백값을 추출. undefined = 패턴 자체를 못 찾음(가드 stale). */
export function extractFeLimitDefault(routeContent: string): number | undefined {
  const m = routeContent.match(FE_LIMIT_DEFAULT_RE);
  return m ? Number(m[1]) : undefined;
}

export function findLimitDefaultMismatches(
  routersDir: string,
  apiDir: string,
  resources: Record<string, { beFile: string; feFile: string }>,
): string[] {
  const violations: string[] = [];
  for (const [resource, { beFile, feFile }] of Object.entries(resources)) {
    let beContent: string;
    try {
      beContent = readFileSync(path.join(routersDir, beFile), 'utf8');
    } catch {
      violations.push(`${resource}: BE 라우터 파일을 못 찾음 — ${beFile}`);
      continue;
    }
    const beDefault = extractBeLimitDefault(beContent);
    if (beDefault === undefined) {
      violations.push(`${resource}: BE limit Query(default=…) 패턴을 못 찾음(${beFile}) — 시그니처가 바뀐 것으로 보임, 가드 정규식 갱신 필요`);
      continue;
    }

    let feContent: string;
    try {
      feContent = readFileSync(path.join(apiDir, feFile), 'utf8');
    } catch {
      violations.push(`${resource}: FE 프록시 파일을 못 찾음 — ${feFile}`);
      continue;
    }
    const feDefault = extractFeLimitDefault(feContent);
    if (feDefault === undefined) {
      violations.push(`${resource}: FE requestedLimit 기본값 패턴을 못 찾음(${feFile}) — 코드가 바뀐 것으로 보임, 가드 정규식 갱신 필요`);
      continue;
    }

    if (beDefault === null) continue; // BE Query(default=None) — 숫자 대조 대상 아님(명시적 스킵)
    if (beDefault !== feDefault) {
      violations.push(`${resource}: BE Query(default=${beDefault})(${beFile}) ≠ FE 기본값 ${feDefault}(${feFile}) — BE 기본값이 바뀌었는데 FE가 안 따라간 것으로 보임`);
    }
  }
  return violations;
}

export function findUnexpectedEventsProxy(apiDir: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const content = readFileSync(full, 'utf8');
      if (content.includes(EVENTS_PENDING_UPSTREAM)) hits.push(path.relative(apiDir, full));
    }
  };
  walk(apiDir);
  return hits;
}

function main(): number {
  const live = listBeHeaderRouters(ROUTERS_DIR);
  console.log(`[AC3①] BE 헤더 발신 라우터 실측 ${live.length}개 · baseline ${FROZEN_BE_HEADER_ROUTERS.length}개 대조`);

  const added = live.filter((n) => !FROZEN_BE_HEADER_ROUTERS.includes(n));
  const removed = FROZEN_BE_HEADER_ROUTERS.filter((n) => !live.includes(n));
  if (added.length > 0 || removed.length > 0) {
    console.error('\n❌ BE 헤더 발신 라우터 baseline이 stale하다(story #3857 AC3):');
    for (const n of added) console.error(`  + ${n}.py가 새로 X-Total-Count/X-Next-Cursor를 낸다 — PROXY_MAP에 FE 소비처를 매핑하고(또는 null로 명시) FROZEN_BE_HEADER_ROUTERS에 추가할 것`);
    for (const n of removed) console.error(`  - ${n}.py가 더 이상 그 헤더를 안 낸다 — FROZEN_BE_HEADER_ROUTERS·PROXY_MAP에서 제거할 것`);
    return 1;
  }
  console.log('OK: BE 헤더 발신 라우터 baseline 일치.');

  console.log(`\n[AC3②] PROXY_MAP ${Object.keys(PROXY_MAP).length}개 자원의 FE 소비 대조`);
  const missing = findMissingMetaSignal(API_DIR, PROXY_MAP);
  if (missing.length > 0) {
    console.error('\n❌ 헤더를 버리는 FE 프록시 발견(story #3857 AC3 — 「한 페이지=전체」 단정 클래스 재발):');
    for (const v of missing) console.error(`  - ${v}`);
    return 1;
  }
  console.log('OK: PROXY_MAP에 매핑된 FE 프록시 전부 헤더를 실제로 읽는다.');

  console.log('\n[AC3②-events] events(「프록시 없음」 전제) 위반 스캔');
  const unexpected = findUnexpectedEventsProxy(API_DIR);
  if (unexpected.length > 0) {
    console.error(`\n❌ PROXY_MAP.events=null 전제가 깨졌다 — ${EVENTS_PENDING_UPSTREAM}를 호출하는 FE 프록시가 생겼다:`);
    for (const f of unexpected) console.error(`  - ${f}`);
    console.error('\n→ 그 프록시가 x-total-count/x-next-cursor를 meta로 옮기는지 확인하고 PROXY_MAP.events를 null에서 그 파일 목록으로 갱신할 것.');
    return 1;
  }
  console.log(`OK: ${EVENTS_PENDING_UPSTREAM}를 쓰는 FE 프록시 없음(전제 유지).`);

  console.log(`\n[PO CHANGES②] BE 기본 limit ↔ FE 기본값 상수 대조(${Object.keys(LIMIT_DEFAULT_RESOURCES).length}개)`);
  const limitMismatches = findLimitDefaultMismatches(ROUTERS_DIR, API_DIR, LIMIT_DEFAULT_RESOURCES);
  if (limitMismatches.length > 0) {
    console.error('\n❌ BE limit 기본값과 FE 하드코딩 기본값이 어긋났다(story #3857 PO CHANGES②):');
    for (const v of limitMismatches) console.error(`  - ${v}`);
    return 1;
  }
  console.log('OK: BE Query(default=…)와 FE 폴백 상수 일치(또는 BE default=None으로 숫자 대조 대상 아님).');

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
