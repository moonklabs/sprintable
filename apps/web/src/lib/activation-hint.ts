/**
 * story #4219 F1(PO 판정) — activation 체크리스트 완주 여부의 **표시용 힌트** 쿠키. 레이아웃이 첫 문서 임계 경로에서
 * `/api/v2/activation/checklist`(dev 중앙 ≈126ms · B그룹의 긴 장대)를 기다리지 않게 한다.
 * - 완주 여부는 체크리스트 응답에서만 나온다(org별 계산 — /me·JWT에 없음). 그래서 클라이언트가 이미 받은 결과를
 *   다음 문서 요청의 힌트로 남긴다: `{orgId}:complete` / `{orgId}:incomplete`.
 * - 레이아웃 세 갈래: complete → 서버 조회 생략(자리 표시 0) · incomplete → 서버 조회 생략(배너 자체의 같은 크기
 *   스켈레톤 → 클라 조회로 채움 · CLS 0) · 없음(새 기기·쿠키 삭제·다른 org) → 지금처럼 서버 await(흔들림 0).
 * - **조언일 뿐**: complete 갈래에서도 하이드레이션 뒤 클라가 임계 경로 밖에서 한 번 다시 읽어 힌트를 갱신한다
 *   (완주는 거의 단조지만 첫 왕복 대화가 지워지면 되돌아갈 수 있다 — 그 드문 경우 배너가 늦게 뜬다).
 * - ⛔권한·데이터 판단에 절대 쓰지 않는다 — 배너를 보일지 말지 **표시**에만. 사용자가 조작해도 영향은 배너 표시뿐.
 */
export const ACTIVATION_HINT_COOKIE = 'sp_activation_hint';
/** 30일 — 완주는 거의 단조라 길어도 되지만, 되돌아간 드문 경우를 자연히 흘려보내게 무기한은 아님. */
export const ACTIVATION_HINT_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type ActivationHint = 'complete' | 'incomplete';

/** 쿠키 값 → 이 org의 힌트. org가 다르거나 모양이 틀리면 없음(undefined — «모른다»로 취급). */
export function parseActivationHint(value: string | undefined | null, orgId: string | undefined | null): ActivationHint | undefined {
  if (!value || !orgId) return undefined;
  const sep = value.lastIndexOf(':');
  if (sep <= 0) return undefined;
  const hintOrg = value.slice(0, sep);
  const hint = value.slice(sep + 1);
  if (hintOrg !== orgId) return undefined;
  return hint === 'complete' || hint === 'incomplete' ? hint : undefined;
}

export function formatActivationHint(orgId: string, complete: boolean): string {
  return `${orgId}:${complete ? 'complete' : 'incomplete'}`;
}

/** 클라이언트가 체크리스트 결과를 받았을 때 힌트를 남긴다(Path=/ · SameSite=Lax · https면 Secure · 만료 있음). */
export function writeActivationHint(orgId: string, complete: boolean): void {
  if (typeof document === 'undefined') return;
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  try {
    document.cookie = `${ACTIVATION_HINT_COOKIE}=${encodeURIComponent(formatActivationHint(orgId, complete))}; Path=/; Max-Age=${ACTIVATION_HINT_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
  } catch {
    // 쿠키 차단 — 다음 문서는 «없음» 갈래(서버 await)로 안전하게 돌아간다.
  }
}

/**
 * story #4219 F1(PO 리뷰 CLS) — 배너 접힘 상태. 예전엔 sessionStorage라 서버가 몰라 자리 표시(스켈레톤)가 늘 펼친 배너 크기였고,
 * 접어 둔 사용자에겐 스켈레톤 → 접힌 칩으로 줄며 흔들렸다. 서버·클라가 같은 값을 읽게 **세션 쿠키**(Max-Age 없음 = 브라우저 세션
 * 동안 · 예전 sessionStorage와 비슷한 수명)로 옮긴다. 값 = 접어 둔 org id(다른 org면 펼침). ⛔표시 외 판단 금지(위와 같음).
 */
export const ACTIVATION_COLLAPSED_COOKIE = 'sp_activation_collapsed';

export function isActivationCollapsed(value: string | undefined | null, orgId: string | undefined | null): boolean {
  return Boolean(value && orgId && value === orgId);
}

export function writeActivationCollapsed(orgId: string, collapsed: boolean): void {
  if (typeof document === 'undefined') return;
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  try {
    document.cookie = collapsed
      ? `${ACTIVATION_COLLAPSED_COOKIE}=${encodeURIComponent(orgId)}; Path=/; SameSite=Lax${secure}`
      : `${ACTIVATION_COLLAPSED_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  } catch {
    // 쿠키 차단 — 이번 렌더만 토글(다음 문서는 펼침)
  }
}
