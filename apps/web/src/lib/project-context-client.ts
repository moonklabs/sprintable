'use client';

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

let interceptorInstalled = false;

/**
 * same-origin `/api/*` 요청에 `X-Project-Id`(탭 effective project)를 주입하는 단일 chokepoint.
 * 호출부 전수 마이그레이션 대신 window.fetch 1점 패치 — raw fetch 호출까지 빠짐없이 커버.
 *
 * - string/URL input 만 처리(코드베이스 호출 패턴). Request input 은 body 유실 방지 위해 무가공 통과.
 * - 이미 `X-Project-Id`/`X-Org-Id` 를 명시한 요청(예: switcher 의 cross-org 프로젝트 로드)은
 *   스킵 — 명시 스코프를 덮지 않는다.
 */
export function installProjectHeaderInterceptor(): void {
  if (interceptorInstalled || typeof window === 'undefined') return;
  interceptorInstalled = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      if (typeof input === 'string' || input instanceof URL) {
        const url = typeof input === 'string' ? input : input.href;
        const path = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];
        const projectId = effectiveProjectIdRef.current;
        // 컨텍스트 제어 엔드포인트(`/api/switch-*`)는 자체 컨텍스트를 관리하므로 주입 제외.
        const isApi = path.startsWith('/api/') && !path.startsWith('/api/switch-');
        if (isApi && projectId) {
          const headers = new Headers(init?.headers);
          if (!headers.has('X-Project-Id') && !headers.has('X-Org-Id')) {
            headers.set('X-Project-Id', projectId);
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
  return serverProjectId;
}
