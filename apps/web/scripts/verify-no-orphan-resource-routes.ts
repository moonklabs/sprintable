/**
 * story #2376 회귀가드 — 「사이드바·팔레트·모바일 더보기가 «없는 라우트»를 걸거나, 라우트가
 * 있는데 «진입점이 없는» 것」을 CI가 잡는다. #2373 승격(PR #2758) 당시 flow 진입점은 들어왔는데
 * flow 라우트가 빠졌고(→404), board는 반대로 라우트 3파일이 남았는데 진입점이 0이었다(→
 * prod 칸반 도달 불가, 더 조용한 쪽 — 사용자가 신고할 대상 자체가 없다). 둘 다 사람이 손으로
 * 「grep 한 번 돌려 봤다」로 통과시켰던 자리다 — #2373 AC5의 검산조차 리터럴 grep(`href:
 * '/flow'`)이라 «조합»된 진입점(resourceLink('flow'))을 놓쳤다(PO 실측 경위, 스토리 본문
 * 참조). 정적 스캔으로 «전수» 축을 세운다.
 *
 * ── AC2 — 입력은 두 축을 «각각 뽑아 합친 뒤» 대조한다 ──────────────────────────
 *   ㉠조합   `resourceLink('x')` · `resourceHref('x')` — app-sidebar.tsx·command-palette.tsx가
 *            각자 로컬로 정의하는 헬퍼(공유 lib 아님 — 실측, grep 전수) — 이름 자체를 정적
 *            스캔 기준으로 삼는다(이 두 이름이 이 레포의 «조합 진입점» 관례다).
 *   ㉡리터럴 `href="/x"` · `href: '/x'` — more/page.tsx(모바일 더보기)·command-palette.tsx의
 *            STATIC_ITEMS처럼 하드코딩된 자리. «단일 세그먼트»만(추가 `/` 없음, 물음표 뒤
 *            쿼리는 허용) — `/mockups/abc123`류 엔티티 딥링크는 다른 축(AC7㉡ 밖)이라 안 뽑는다.
 *
 * ── AC3 — 양방향 ─────────────────────────────────────────────────────────
 *   entryWithoutRoute: 진입점은 있는데 `[ws]/[proj]/<resource>` 라우트가 없다 → 404로 가는 링크.
 *   routeWithoutEntry: 라우트(`page.tsx` 실존)는 있는데 위 두 축 어디에도 그 이름이 없다
 *                      → ⭐더 조용한 쪽(도달 불가, 아무도 「없어졌다」고 말 안 해줌).
 *
 * ── EXEMPT — 오탐 0건이 설계 전제(env-drift-guard 관례 재사용) ──────────────────
 *   ①KNOWN_NON_PROJECT_ROUTES — story #2387(2026-08-01) 후속: `apps/web/src/app/*` +
 *     `app/(authenticated)/*`를 매 실행마다 `readdirSync`로 다시 읽는다(`listTopLevelDirs`).
 *     예전엔 손 스냅샷("2026-08-01 실측"으로 얼린 목록)이었다 — `[ws]/[proj]/<resource>`
 *     실존은 이미 `listRouteDirs`로 파생시키면서 이쪽만 손으로 유지할 이유가 없었다(#2387
 *     PO 지적: 「파생이 이미 되는 곳이 있으면 «못 한다»가 아니라 «안 한 것»」). ⚠️최초
 *     스캔(2026-08-01)에서 이 목록을 `(authenticated)`만으로 좁게 잡았다가 로그인 전 공개
 *     라우트 7개(login↔register↔forgot-password↔privacy↔terms↔verify-email↔onboarding —
 *     서로 링크를 주고받는 자리라 「단일 세그먼트 리터럴」축에 우르르 걸림)가 오탐으로 뜬
 *     것을 보고 `app/*` 전수로 넓혔다(AC4④의 실측 사례) — 파생으로 바뀐 지금도 두 루트
 *     (app/*·app/(authenticated)/*) 다 읽는 이유가 그것이다.
 *   ②RENAMED_RESOURCE_ALIASES — story #2387(2026-08-01) 후속: `apps/web/src/proxy.ts`가
 *     export하는 `RENAMED_RESOURCES ∪ RETIRED_RESOURCES` 키에서 직접 파생시킨다(위 import).
 *     예전엔 그 두 표의 키를 손으로 옮겨 적은 Set이었다 — proxy.ts가 바뀌어도 안 바뀌어
 *     조용히 어긋날 수 있었다(story #2378 리뷰, 유나양 발견 — `mockups`가 실은
 *     `RETIRED_RESOURCES`(id 폐기) 값인데 스냅샷 이름만 보면 `RENAMED_RESOURCES`(id 보존)
 *     쪽으로 잘못 읽혔다). 카디르군 QA 판정: 두 표를 합쳐도 **사용자 체감 동작**(리다이렉트는
 *     `redirectRenamedResourcePath`/`redirectRetiredResourcePath`로 이미 분리 구현)엔
 *     혼동 위험이 없다 — 혼동은 이 CI 전용 상수 하나에 한정됐던 것이라 파생으로 없앤다.
 *     이 이름들을 직접 가리키는 진입점은 없지만(전부 최종 목적지를 직접 가리키게 이미 고쳐짐
 *     — command-palette.tsx의 `boardHref` 주석 참조), 이 표에 있는 이름이 «장래에» 진입점
 *     target으로 다시 등장해도 오탐이 아니게 미리 막는다.
 *
 * ── AC3(story #2387) — 같은 성질의 «다른 손 스냅샷» 스윕 ──────────────────────
 *   찾은 것 3개, 고친 것 2개(이 파일 안의 ①②) — 나머지 1개는 이 스토리 스코프 밖:
 *   `apps/web/src/lib/route-resolve.ts`의 `RESERVED_FIRST_SEGMENTS`가 같은 병이다("현재
 *   라이브 flat 라우트 첫 세그먼트 전부(2026-07-15 grounding, apps/web/src/app/ 실측)"라고
 *   스스로 적은 손 스냅샷 — 새 top-level 라우트가 생겨도 안 늘어나면 조용히 어긋난다). 이
 *   가드가 아니라 **런타임 미들웨어 라우팅 판정**(`looksLikeWorkspaceSegment`)이 그 값을
 *   직접 쓰므로, 고치면 이 스토리(CI 전용 상수 정리)보다 넓은 리스크(실 요청 라우팅 변경)를
 *   지고 별도 리뷰가 필요하다 — 여기서는 발견만 기록하고 후속 스토리로 남긴다.
 *
 * AC7 — 이 가드가 «못 잡는 것» (선언 없이 초록이면 「전부 봤다」로 읽힌다):
 *   ㉠런타임에 조립되는 경로 — `resourceLink(variable)`처럼 문자열 리터럴이 아닌 인자, 또는
 *     `router.push(`/${x}`)`류 템플릿 조합. 정규식은 리터럴만 본다.
 *   ㉡`(authenticated)` 안이라도 `[ws]/[proj]` 밖의 라우트(`/organization/workforce`처럼
 *     세그먼트가 2개 이상인 하드코딩 href, `/gates/[id]` 등 엔티티 상세) — AC1이 대조하는
 *     축 자체가 `[ws]/[proj]/<resource>` 하나뿐이다.
 *   ㉢`<Link href>`/헬퍼 리턴값이 아니라 `router.push()`·`window.location` 류 프로그램적 이동
 *     — 단 `window.location.href = 'x'` 대입은 `href\s*[:=]` 정규식에 우연히 같이 걸린다
 *     (onboarding 케이스, AC8 스캔에서 실측 확認 — 못 잡는다가 아니라 덤으로 걸리는 쪽).
 *   ㉣(story #2387 AC4) `RENAMED_RESOURCE_ALIASES` 파생은 `proxy.ts`의 `RENAMED_RESOURCES`·
 *     `RETIRED_RESOURCES` 두 표만 본다 — `MIGRATED_RESOURCES`(bare legacy URL을 ws/proj로
 *     채워 넣는 축, 세그먼트 자체가 없던 자리를 다루는 다른 관심사)는 의도적으로 안 본다.
 *     proxy.ts에 리소스 별칭 성격의 네 번째 표가 또 생기면 이 파생은 그 표를 자동으로 안
 *     잡는다 — 그때는 이 import 목록에 그 표도 추가해야 한다(그래도 "고쳐야 할 자리가
 *     하나"라는 점은 손 스냅샷보다 낫다 — 어긋나는 게 아니라 빠뜨리는 것이라 눈에 띈다).
 *
 * ⚠️CI 안전장치 — GRANDFATHER_BASELINE을 둔다. PO는 2026-08-01 사전 협의에서 「어제 실측(#2373
 * AC5 검산)으로 짝이 다 맞으니 첫 스캔은 0건이 정상」이라 예상했으나, «전수»(AC2) 스캔은 그
 * 어제 실측(사이드바·팔레트·더보기 3자리, 총 10개 리소스)이 애초에 보지 않은 파일까지 봐서
 * 실제로 2건을 새로 잡았다 — grep 손 검산이 아니라 자동 전수 스캔이라 나온 차이 그 자체가
 * 이 스토리의 존재 이유를 증명한다:
 *   ①`routeWithoutEntry: mockups` — `[ws]/[proj]/mockups`(목업 3파일)에 사이드바·팔레트·
 *     더보기 어디서도 안 걸리는 진입점 0건. PO의 어제 실측 목록(스토리 본문 "나머지 8개"
 *     +flow+board)에 애초에 없던 리소스 — 손 검산이 «놓쳤던» 자리.
 *   ②`entryWithoutRoute: memos` — `services/notification-navigation.ts`가 `reference_type
 *     ==='memo'` 알림을 `/memos?id=...`로 보내는데 그 이름의 라우트가 앱 어디에도 없다.
 *     ⭐같은 파일의 바로 아래(`task` 케이스) 주석이 이미 "`/boards`(오탈자·복수형)라 알림
 *     클릭이 항상 무효였다"는 동형 사고를 한 번 고친 전례를 남기고 있다 — `memo`가 같은
 *     클래스의 두 번째 사례로 보인다.
 * ⛔AC6에 따라 이 스토리(#2376)는 위 2건을 «고치지 않는다» — GRANDFATHER_BASELINE에 이유와
 * 함께 얼려 두고 별도 triage로 넘긴다(#2367의 GRANDFATHER_BASELINE·40건과 동일 관례). PO
 * 승인 없이 조용히 추가되지 않게 COUNT_TEST로 크기를 고정한다.
 *
 * ⭐후속(story #2379, 2026-08-01) — `entryWithoutRoute: memos` 정리 완료. notification-
 * navigation.ts의 memo 분기 제거(기본 fallback href:null로 흡수) + backend EventType.
 * memo_created/memo_replied 화석 제거. baseline에서 뺐다 — staleness 체크가 「고쳐졌는데
 * 목록에 남음」을 잡아 주는 자리라 여기서 그 값이 실증된다.
 *
 * ⭐후속(story #2378, 2026-08-01) — `routeWithoutEntry: mockups`도 정리 완료. PO 판단: 은퇴
 * (진입점 0이 「의도」가 아니라 dev DB 실측 결과 `mockups` 테이블 자체가 없고 scenarios/
 * versions/pages 전부 0건 — 열어도 500인 «껍데기»였다). `[ws]/[proj]/mockups` 라우트 5파일 +
 * `components/mockups/*` + `/api/mockups/*`·`/api/mcp/mockups`(백엔드 대응 라우트 자체가
 * 없던 깨진 프록시) + i18n `mockup` 네임스페이스(69키)+`nav.mockup` 전부 제거, `proxy.ts`
 * `RETIRED_RESOURCES`(유나양 design:changes로 `RENAMED_RESOURCES`와 분리— id를 버리는 폐기
 * 축)에 `mockups: 'artifacts'`(E-CANVAS 부분 후계)로 도착지를 남겼다.
 * baseline에서 뺐다 — 라우트 자체가 없어졌으니 이 스캔에 다시 안 잡히는 것이 정상이고,
 * staleness 체크가 그것을 확認한다. GRANDFATHER_BASELINE이 이제 빈 Set이다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { RENAMED_RESOURCES, RETIRED_RESOURCES } from '../src/proxy';

const SRC_ROOT = path.resolve(process.cwd(), 'src');
const APP_ROOT = path.resolve(SRC_ROOT, 'app');
const AUTHENTICATED_ROOT = path.resolve(APP_ROOT, '(authenticated)');
const PROJECT_RESOURCE_ROOT = path.resolve(SRC_ROOT, 'app/(authenticated)/[ws]/[proj]');
const EXT_RE = /\.(tsx?|jsx?)$/;
const TEST_RE = /\.(test|spec)\.[tj]sx?$/;

export interface EntryHit {
  target: string;
  file: string;
  kind: 'composed' | 'literal';
}

// ── ㉠조합 진입점 — resourceLink('x') / resourceHref('x') ──────────────────

const COMPOSED_CALL_RE = /\bresource(?:Link|Href)\(\s*(['"])([a-zA-Z][a-zA-Z0-9_-]*)\1\s*\)/g;

export function extractComposedTargets(content: string): string[] {
  return [...content.matchAll(COMPOSED_CALL_RE)].map((m) => m[2]!);
}

// ── ㉡리터럴 진입점 — href="/x" / href: '/x' (단일 세그먼트, 선택적 쿼리) ───────

const LITERAL_HREF_RE = /\bhref\s*[:=]\s*(['"`])\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\?[^'"`]*)?\1/g;

export function extractLiteralTargets(content: string): string[] {
  return [...content.matchAll(LITERAL_HREF_RE)].map((m) => m[2]!);
}

// ── ①파생(story #2387, 2026-08-01) — [ws]/[proj] 밖의 모든 app/ 라우트를 매 실행마다
// readdirSync로 다시 읽는다. 예전엔 손으로 옮겨 적은 스냅샷("2026-08-01 실측")이었다 — 새
// 최상위 라우트가 생겨도 이 목록이 안 늘어나면 조용히 어긋날 수 있었다(AC1: 「어긋나는
// 길이 없어지는」 쪽이 「어긋나면 잡는 가드」보다 위). `[ws]/[proj]/<resource>` 실존을 이미
// readdirSync로 파생시키는 `listRouteDirs`와 동형 — 그쪽만 파생이고 이쪽만 손 스냅샷일
// 이유가 없었다(#2387 PO 지적).
function listTopLevelDirs(dir: string): string[] {
  return readdirSync(dir).filter((entry) => statSync(path.join(dir, entry)).isDirectory());
}

export const KNOWN_NON_PROJECT_ROUTES = new Set<string>([
  // app/* — 로그인 전 공개 라우트 + auth/dashboard. `(authenticated)`는 URL에 안 나타나는
  // Next.js route group이라 제외(그 자식은 아래에서 따로 나열).
  ...listTopLevelDirs(APP_ROOT).filter((d) => d !== '(authenticated)'),
  // app/(authenticated)/* — [ws]/[proj] 밖의 인증 후 최상위 라우트. `[ws]`는 프로젝트
  // 스코프 트리 자신이라 "밖"이 아니므로 제외.
  ...listTopLevelDirs(AUTHENTICATED_ROOT).filter((d) => d !== '[ws]'),
]);

// ── ②파생(story #2387) — apps/web/src/proxy.ts가 미들웨어 301로 대신 처리하는 리소스명을
// 그 소스(RENAMED_RESOURCES·RETIRED_RESOURCES, 위에서 import)에서 직접 읽는다. 예전엔 이
// 두 표의 키를 손으로 옮겨 적은 Set(`['epics','glance','board','mockups']`)이었다 —
// proxy.ts가 바뀌어도 그 스냅샷은 안 바뀌어 조용히 어긋날 수 있었다(story #2378 리뷰,
// 유나양 발견 — `mockups`가 실은 `RETIRED_RESOURCES` 값인데 스냅샷 이름만 보면 rename으로
// 잘못 읽혔다). rename(id 보존)과 retire(id 폐기)는 사용자 체감 동작(리다이렉트)에서는
// 이미 서로 다른 함수(`redirectRenamedResourcePath`/`redirectRetiredResourcePath`)로
// 갈려 있다(카디르군 QA 판정: 축 혼동 위험은 CI 전용 상수에 한정, 제품 동작엔 없음) — 이
// 가드는 「[ws]/[proj] 라우트 대신 프록시가 처리하는 이름」이라는 한 가지 사실만 보므로
// 두 표를 합쳐도 그 판정이 흐려지지 않는다.
export const RENAMED_RESOURCE_ALIASES = new Set<string>([
  ...Object.keys(RENAMED_RESOURCES),
  ...Object.keys(RETIRED_RESOURCES),
]);

export const EXEMPT_TARGETS = new Set<string>([...KNOWN_NON_PROJECT_ROUTES, ...RENAMED_RESOURCE_ALIASES]);

// ── GRANDFATHER_BASELINE — 첫 스캔(2026-08-01)이 잡은 기존 채무. AC6: #2376 스토리는 안
// 고친다. 새 항목부터는 PO 승인 없이 조용히 추가되지 않는다(#2367 관례 재사용) —
// GRANDFATHER_BASELINE_COUNT_TEST가 크기를 고정, staleness 체크가 "고쳐졌는데 목록에
// 남은" 항목을 잡는다. `entryWithoutRoute:memos`는 story #2379가, `routeWithoutEntry:
// mockups`는 story #2378이 실제로 고치고 여기서 뺐다 — 둘 다 staleness 체크가 그 자리에서
// 값을 했다(빈 Set이 된 것 자체가 "지금 아는 채무 0건"이라는 사실이다).
export const GRANDFATHER_BASELINE = new Set<string>([]);

// ── 라우트 실존 — [ws]/[proj]/<resource>/page.tsx 직접 존재 ────────────────────

export function listRouteDirs(root: string): string[] {
  return readdirSync(root)
    .filter((entry) => statSync(path.join(root, entry)).isDirectory())
    .filter((entry) => {
      try {
        return statSync(path.join(root, entry, 'page.tsx')).isFile();
      } catch {
        return false;
      }
    });
}

// ── 파일 순회 (i18n 가드와 동형) ─────────────────────────────────────────────

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) out.push(full);
  }
}

// ── AC3 판정 ────────────────────────────────────────────────────────────

export function findEntryWithoutRoute(
  hits: EntryHit[],
  routeDirs: Set<string>,
  exempt: Set<string>,
): Map<string, EntryHit[]> {
  const byTarget = new Map<string, EntryHit[]>();
  for (const hit of hits) {
    if (exempt.has(hit.target) || routeDirs.has(hit.target)) continue;
    if (!byTarget.has(hit.target)) byTarget.set(hit.target, []);
    byTarget.get(hit.target)!.push(hit);
  }
  return byTarget;
}

export function findRouteWithoutEntry(routeDirs: string[], hits: EntryHit[]): string[] {
  const referenced = new Set(hits.map((h) => h.target));
  return routeDirs.filter((dir) => !referenced.has(dir));
}

// ── main ────────────────────────────────────────────────────────────────

function main(): void {
  const files: string[] = [];
  walk(SRC_ROOT, files);

  const routeDirsList = listRouteDirs(PROJECT_RESOURCE_ROOT);
  const routeDirs = new Set(routeDirsList);

  const hits: EntryHit[] = [];
  let composedCount = 0;
  let literalCount = 0;
  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
    for (const target of extractComposedTargets(content)) {
      hits.push({ target, file: rel, kind: 'composed' });
      composedCount += 1;
    }
    for (const target of extractLiteralTargets(content)) {
      hits.push({ target, file: rel, kind: 'literal' });
      literalCount += 1;
    }
  }

  const entryWithoutRoute = findEntryWithoutRoute(hits, routeDirs, EXEMPT_TARGETS);
  const routeWithoutEntry = findRouteWithoutEntry(routeDirsList, hits);

  const uniqueTargets = new Set(hits.map((h) => h.target));
  console.log(
    `[AC8] 진입점 스캔 — 파일 ${files.length}개 · 조합 호출 ${composedCount}건 · 리터럴 호출 ${literalCount}건 · ` +
      `고유 target ${uniqueTargets.size}개 · 라우트 ${routeDirsList.length}개(${routeDirsList.sort().join(', ')}) · ` +
      `exempt ${EXEMPT_TARGETS.size}개(known-non-project ${KNOWN_NON_PROJECT_ROUTES.size} + renamed-alias ${RENAMED_RESOURCE_ALIASES.size}) · ` +
      `grandfather(미triage 채무, 안 막음) ${GRANDFATHER_BASELINE.size}건`,
  );

  const baselineHit = new Set<string>();
  let failed = false;

  if (entryWithoutRoute.size > 0) {
    const newOnes = [...entryWithoutRoute].filter(([target]) => {
      const key = `entryWithoutRoute:${target}`;
      if (GRANDFATHER_BASELINE.has(key)) { baselineHit.add(key); return false; }
      return true;
    });
    if (newOnes.length > 0) {
      failed = true;
      console.log(`\n❌ entryWithoutRoute(신규) — 진입점은 있는데 [ws]/[proj] 라우트가 없다(404로 가는 링크) ${newOnes.length}건:`);
      for (const [target, targetHits] of newOnes.sort(([a], [b]) => a.localeCompare(b))) {
        for (const h of targetHits) console.log(`  - target="${target}" [${h.kind}] ${h.file}`);
      }
    }
  }

  if (routeWithoutEntry.length > 0) {
    const newOnes = routeWithoutEntry.filter((dir) => {
      const key = `routeWithoutEntry:${dir}`;
      if (GRANDFATHER_BASELINE.has(key)) { baselineHit.add(key); return false; }
      return true;
    });
    if (newOnes.length > 0) {
      failed = true;
      console.log(`\n❌ routeWithoutEntry(신규) — 라우트는 있는데 진입점이 어디에도 없다(도달 불가, 더 조용한 쪽) ${newOnes.length}건:`);
      for (const dir of [...newOnes].sort()) console.log(`  - [ws]/[proj]/${dir}`);
    }
  }

  const staleBaseline = [...GRANDFATHER_BASELINE].filter((k) => !baselineHit.has(k));
  if (staleBaseline.length > 0) {
    console.log(`  ⚠️ grandfather로 등재됐으나 이번 스캔에서 안 걸린(고쳐졌다면 목록에서 빼도 되는): ${staleBaseline.join(', ')}`);
  }
  if (baselineHit.size > 0) {
    console.log(`\n📋 grandfather(#2376 최초 스캔·#2379 triage — AC6: 이 스토리는 안 고친다): ${[...baselineHit].join(', ')}`);
  }

  if (failed) {
    console.log(
      '\n→ 진입점 target과 [ws]/[proj] 라우트 이름이 어긋난다(사실). 어느 쪽이 정본인지는 이 가드가 ' +
        '판정하지 않는다(AC6) — 진입점을 지울지 라우트를 넣을지는 그 축의 주인(제품 판단) 몫이다. ' +
        '정말 안 어긋나는 게 맞으면 EXEMPT에, 지금은 못 고치지만 알고 있는 채무면 GRANDFATHER_BASELINE에 이유와 함께 등재.',
    );
    process.exit(1);
  }

  console.log(`OK: 새 entryWithoutRoute·routeWithoutEntry 0건(grandfather ${baselineHit.size}건은 위 목록대로 남아있음 — 신규만 막는다)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
