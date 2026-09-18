'use client';

import { useSyncExternalStore } from 'react';

/**
 * 프로젝트 컨텍스트 SSOT (R2: d802da27 stale context / 85614dd9 멀티탭 독립).
 *
 * 기존 SSOT = 쿠키 `sprintable_current_project_id`(브라우저 전역, 탭 공유) → 탭A 전환이 탭B에
 * 새서 stale·잘못된 프로젝트 mutation 위험. 이 모듈은 **URL `?p=` 를 탭별 SSOT** 로 삼고,
 * 링크가 `?p=` 를 떨궈도 stale 로 안 빠지게 **sessionStorage(탭별) backstop** 을 둔다.
 *
 * mutation 안전의 권위 게이트는 BE — fetch 인터셉터가 same-origin `/api/*` 요청에
 * `X-Project-Id` 헤더(탭의 effective project)를 실어 보내고, BE 가 멤버십 검증해 그 프로젝트로
 * 스코프한다(미달 403). FE 의 멤버십 필터는 UX/intent(valid `?p=` 선택)일 뿐 보안 게이트가 아니다.
 */

/** 탭별 선택 프로젝트 backstop 키 — sessionStorage 는 탭 스코프라 멀티탭 독립이 자연 성립. */
export const TAB_PROJECT_STORAGE_KEY = 'sprintable_tab_project_id';

/** fetch 인터셉터가 읽는 현재 탭 effective projectId (provider 가 갱신). */
const effectiveProjectIdRef: { current: string | undefined } = { current: undefined };

export function setEffectiveProjectId(id: string | undefined): void {
  effectiveProjectIdRef.current = id;
}

// story #2497 — fire #2486 근본원인(라이브 실증): 인터셉터가 X-Project-Id만 보내고
// X-Org-Id는 안 보내, backend get_verified_org_id가 org_id=(X-Org-Id ?? JWT
// app_metadata.org_id)로 스코프하는 자리에서 멀티-org 유저의 stale JWT org가 현재
// 탭의 실제 org와 달라 has_project_access가 엉뚱한 org로 검증돼 정당한 프로젝트도
// 403 났다(#2490의 "25d3a6df는 out-of-org stale" 전제는 틀렸음 — in-org·정당 접근권,
// 진짜 원인은 이 헤더 누락). effectiveProjectIdRef와 대칭으로 탭의 effective org도
// 추적해 같이 실어 보낸다.
const effectiveOrgIdRef: { current: string | undefined } = { current: undefined };

export function setEffectiveOrgId(id: string | undefined): void {
  effectiveOrgIdRef.current = id;
}

// story #2545(카디르 라이브 재QA, 2단계) — DashboardShell의 자동 switch-org(불일치 감지 →
// 토큰 재발급, 위 참고)가 성공한 뒤 `router.refresh()`는 **서버 컴포넌트만** 재실행한다.
// hypotheses/goals처럼 `useEffect(() => fetch(...), [projectId])`로 짜인 클라이언트 fetch는
// projectId가 그대로면(이 결함에선 org만 바뀌고 project는 그대로다) effect가 다시 안 돌아
// switch-org 이전에 이미 확定된 403/404 결과에 영구히 고정된다(카디르 실측: 8초 관측·
// hypotheses fetch 총 1회뿐 — RSC 위젯은 refresh로 정상 회복하는 것과 대조).
// 전체 fetch를 org-sync 완료까지 게이트하는 건 앱 전역 컴포넌트를 건드리는 큰 변경이라
// (PO 판정) 이번 스코프 밖 — 대신 이 값을 구독하는 컴포넌트만 "org sync가 방금 완료됐다"는
// 신호를 받아 자기 effect 의존성 배열에 얹어 재요청하게 한다(옵트인, 전수 마이그레이션 아님).
let orgSyncVersion = 0;
const orgSyncListeners = new Set<() => void>();

/** DashboardShell이 switch-org 성공 直後 정확히 한 번 호출 — 구독 컴포넌트를 재요청시킨다. */
export function bumpOrgSyncVersion(): void {
  orgSyncVersion += 1;
  for (const listener of orgSyncListeners) listener();
}

function subscribeOrgSyncVersion(callback: () => void): () => void {
  orgSyncListeners.add(callback);
  return () => { orgSyncListeners.delete(callback); };
}

function getOrgSyncVersionSnapshot(): number {
  return orgSyncVersion;
}

function getOrgSyncVersionServerSnapshot(): number {
  return 0; // SSR/최초 하이드레이션은 항상 0 — 서버·클라 첫 렌더 불일치 없음.
}

/** org 자동 동기화(switch-org)가 방금 성공적으로 끝났음을 신호받는 훅. 반환값이 바뀔 때마다
 * 구독 컴포넌트를 재렌더시키므로, 이 값을 fetch effect의 의존성 배열에 얹으면 org-sync 성공
 * 直後 그 fetch가 재요청된다(예: `useEffect(() => { ... }, [projectId, orgSyncVersion])`). */
export function useOrgSyncVersion(): number {
  return useSyncExternalStore(subscribeOrgSyncVersion, getOrgSyncVersionSnapshot, getOrgSyncVersionServerSnapshot);
}

let interceptorInstalled = false;

/**
 * same-origin `/api/*` 요청에 `X-Project-Id`+`X-Org-Id`(탭 effective project/org)를
 * 주입하는 단일 chokepoint. 호출부 전수 마이그레이션 대신 window.fetch 1점 패치 —
 * raw fetch 호출까지 빠짐없이 커버.
 *
 * - string/URL input 만 처리(코드베이스 호출 패턴). Request input 은 body 유실 방지 위해 무가공 통과.
 * - 이미 `X-Project-Id`/`X-Org-Id` 를 명시한 요청(예: switcher 의 cross-org 프로젝트 로드)은
 *   스킵 — 명시 스코프를 덮지 않는다.
 * - story #2497 — 둘을 항상 «함께» 싣는다(하나만 실으면 멀티-org 유저에서 org_id가
 *   JWT stale org로 새는 이 fire의 정확한 재발 형태다).
 *
 * ⚠️story #3260 4차 finding(2026-08-31, 유나 5축 라이브 재검 — CSP 뚫린 뒤 드러난 층) — 이
 * "same-origin" 전제가 실제로는 **path 모양만** 봤다: 절대 URL(`http...`)이면 `new
 * URL(url).pathname`만 뽑아 `/api/`로 시작하는지만 확認하고, 그 URL의 **origin/host는
 * 아예 확認하지 않았다**. Support Gateway(`https://support-gateway-dev-...run.app/api/v1/
 * sessions`, gateway-client.ts가 raw fetch로 부름)의 pathname이 하필 `/api/`로 시작해
 * 이 "same-origin" 인터셉터가 **cross-origin 요청에도** X-Project-Id/X-Org-Id를 실어
 * 버렸다 — Gateway는 Bearer 위임토큰만 신뢰하는 경계 서비스라 그 헤더들을 CORS
 * Access-Control-Allow-Headers에 안 뒀고(경계를 무르게 해서 통과시키는 처방은 페드루 PO가
 * 명시 기각), 그래서 OPTIONS 프리플라이트가 400으로 거부돼 POST 자체가 ERR_FAILED 났다.
 * 처방: origin도 함께 확認해 실제 **동일 출처**일 때만 주입한다(cross-origin 절대 URL은
 * path가 뭘 닮았든 스킵).
 */
export function installProjectHeaderInterceptor(): void {
  if (interceptorInstalled || typeof window === 'undefined') return;
  interceptorInstalled = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      if (typeof input === 'string' || input instanceof URL) {
        const url = typeof input === 'string' ? input : input.href;
        const isAbsolute = /^https?:\/\//.test(url);
        // 절대 URL이면 origin까지 파싱해 실제 동일 출처인지 확認한다 — path 모양(`/api/...`)만
        // 보고 판단하면 cross-origin 서비스(예: Support Gateway)에도 새 나간다(위 finding).
        const sameOrigin = !isAbsolute || new URL(url).origin === window.location.origin;
        const path = isAbsolute ? new URL(url).pathname : url.split('?')[0];
        const projectId = effectiveProjectIdRef.current;
        const orgId = effectiveOrgIdRef.current;
        // 컨텍스트 제어 엔드포인트(`/api/switch-*`)는 자체 컨텍스트를 관리하므로 주입 제외.
        const isApi = sameOrigin && path.startsWith('/api/') && !path.startsWith('/api/switch-');
        if (isApi && projectId) {
          const headers = new Headers(init?.headers);
          if (!headers.has('X-Project-Id') && !headers.has('X-Org-Id')) {
            headers.set('X-Project-Id', projectId);
            if (orgId) headers.set('X-Org-Id', orgId);
            return originalFetch(input, { ...init, headers });
          }
        }
      }
    } catch {
      // 인터셉터 실패는 원본 fetch 로 폴백 — 네트워크 동작을 절대 깨지 않는다.
    }
    return originalFetch(input, init);
  };
}

/**
 * 탭 effective project 해소 — 우선순위: **경로(`[ws]/[proj]`) resolve 결과** → URL `?p=` →
 * sessionStorage backstop → 서버 prop(쿠키 유래). 후보가 accessible(`accessibleIds`)일 때만
 * 채택(UX/intent 필터, 보안 아님) — 단 `pathProjectId`는 예외(아래 참고). 무효면 다음 우선순위.
 *
 * story #2093 — `?p=`는 원래 "탭별 SSOT"였으나 `/{ws}/{proj}/...` 경로 세그먼트도 탭마다
 * 다른 값이라 같은 일을 하는 두 번째 축이었다. 두 축이 갈리는 자리(북마크·딥링크 등 `?p=` 없이
 * 경로로 직접 진입)에서 화면 본문은 경로를 따르는데 이 함수는 계정 상태로 폴백해 top-bar 칩이
 * 다른 프로젝트를 그렸다(라이브 재현). `pathProjectId`(proxy.ts가 URL 경로를 서버측에서 resolve해
 * `x-resolved-project-id` 헤더로 실어보낸 값)를 최우선으로 승격해 두 축을 하나로 합친다.
 * `?p=`는 경로 세그먼트가 없는 flat 라우트(`/glance`·`/inbox` 등, TAB_ROOT_PREFIXES)에서 여전히
 * 유일한 탭별 SSOT라 유지한다 — 그 라우트들은 애초에 `pathProjectId`가 없다(resolve 미대상).
 *
 * `pathProjectId`는 accessibleIds 체크를 안 받는다 — `?p=`/sessionStorage는 클라이언트가 임의로
 * 들고 있을 수 있는 값이라 멤버십 재확인이 필요하지만, `pathProjectId`는 proxy.ts가 같은
 * accessToken으로 BE resolve(`/api/v2/resolve`)를 이미 통과시킨 서버측 검증 결과라 재검증이
 * 중복이다(그리고 cross-org 진입 시 `accessibleIds`가 계정의 "현재 org" 멤버십에만 스코프돼
 * 있어 오탈락할 수 있다 — 그 경우 이 우선순위가 없으면 정확한 값도 걸러진다).
 *
 * `hydrated`(기본 true, 명시적으로 false를 넘길 때만 sessionStorage 무시) — 라이브 재현(2026-07-11)
 * 대응: sessionStorage는 브라우저 전용이라 SSR(`window` 없음)에선 원천적으로 못 읽는다. 이 함수
 * 호출부(`useProjectSsot`)가 하이드레이션 완료 전엔 `hydrated=false`를 넘겨, 첫 클라이언트 렌더가
 * 서버 렌더와 동일한 값(경로/URL/serverProjectId 기준)을 내도록 강제한다 — 안 그러면 SSR과 첫
 * CSR 사이에 값이 갈려 하이드레이션 직후 예상 밖 URL 정규화(router.replace)가 발동할 수 있다.
 */
export function resolveEffectiveProjectId(
  urlProjectId: string | null,
  serverProjectId: string | undefined,
  accessibleIds: ReadonlySet<string>,
  hydrated = true,
  pathProjectId?: string,
): string | undefined {
  if (pathProjectId) return pathProjectId;
  if (urlProjectId && accessibleIds.has(urlProjectId)) return urlProjectId;
  if (hydrated && typeof window !== 'undefined') {
    const stored = window.sessionStorage.getItem(TAB_PROJECT_STORAGE_KEY);
    if (stored && accessibleIds.has(stored)) return stored;
  }
  // story #2490 — 이전엔 이 마지막 폴백(serverProjectId, me.project_id=쿠키/JWT 유래)만
  // accessibleIds 체크가 없었다. stale한 값이 비멤버 프로젝트를 가리키면 무검증으로
  // 채택돼(fire #2486 재현, 퍼펫티어 실측) X-Project-Id로 실려 project-gated 엔드포인트를
  // 오작동시켰다 — 다른 멤버 프로젝트로 «조용히 점프»하지 않고 미선택(undefined) 상태로
  // 떨어뜨린다(호출부 대부분이 이미 `!projectId` 가드로 graceful 폴백 UI를 갖고 있다).
  if (serverProjectId && accessibleIds.has(serverProjectId)) return serverProjectId;
  return undefined;
}

/**
 * story #2873 — flat 라우트(경로에 org 세그먼트가 없는 화면)에서 세션의 "현재 org"를 판정한다.
 * `pathOrgId`(경로 `[ws]/[proj]` resolve 결과)가 최우선(기존 동작 그대로). 그다음은
 * `jwtOrgId`(JWT `app_metadata.org_id` 클레임 — getServerSession이 jwtVerify 직후 읽어둔 정본)
 * 를 `orgId`(project_id-체인으로 파생된 값)보다 우선한다: 0-프로젝트 org로 전환하면 그 org엔
 * 앵커할 project가 없어 project-chain 파생값이 새 org로 영영 못 넘어가지만(switch-org가
 * CURRENT_PROJECT_COOKIE를 지운다), 새로 발급된 JWT의 org_id 클레임 자체는 switch-org 직후
 * 정확히 갱신되어 있다(BE 실측 확認, story #2873). jwtOrgId가 없는 인증경로(Firebase 세션 —
 * db/server.ts 참고)에서만 orgId(project-chain)로 폴백한다.
 */
export function resolveEffectiveOrgId(
  pathOrgId: string | undefined,
  jwtOrgId: string | undefined,
  orgId: string | undefined,
): string | undefined {
  return pathOrgId ?? jwtOrgId ?? orgId;
}
