import type { SitePostApiErrorKind } from './api-error';

// story #3402(Phase1·마케팅운영, doc §5 각주·AC11) — "막혔다"와 "밖으로 나갔다"는 다르다.
// http_status가 null인 응답은 "모른다"가 아니라 "HTTP 실패 자체가 없었다"는 뜻이다(§5
// 각주 원문): ①서버가 200을 주었는데 내용이 거부된 것(통신은 성공, 판정이 막음) ②네트워크를
// 아예 타지 않은 로컬 입력 검증. 이 구분이 §5-1(「막혔다」≠「밖으로 나갔다」)의 근거다 —
// null을 "모름"으로 읽으면 화면이 있지도 않은 외부 호출 실패를 찾게 된다.
//
// 페드루 PO 블로커 판정(2026-09-04 06:17Z) — v1은 httpStatus===502만 reached_provider로
// 보고 «나머지 전부»를 not_sent로 뒀다. 이러면 500/503/504·BFF 400·서버가 아직 안 낸
// 미지 코드에서도 "흔적이 남지 않았습니다"를 단정하게 되는데, 그건 실제로 모르는 것을
// 아는 것처럼 그리는 것이다(§17-4 "모른다≠아니다" 규율 정면 위반). 판정 축을 http_status
// 숫자가 아니라 **오류 코드의 kind**로 바꾼다 — kind는 이미 parseSitePostApiError가
// KNOWN_ERRORS 매핑으로 계산해 두고, 매핑에 없는 코드는 전부 kind='unknown'으로 fail-closed
// 되어 있다(api-error.ts 173행). 즉 500/503/504/BFF 400/신규 미지 코드는 전부 자동으로
// kind='unknown'이 되므로 이 함수가 그 목록을 따로 들고 있을 필요가 없다.
export type ExternalImpact = 'not_sent' | 'reached_provider' | 'unknown';

// AC10 12행 표 기준 "관문 前에서 멈춘다"(Threads로 요청 자체가 안 나간다)고 명시된 kind만
// not_sent다. 새 코드가 추가되면 KNOWN_ERRORS에 kind를 명시적으로 붙여야 여기 들어온다 —
// 표에 없는 kind를 넣지 않는다(지어내지 않는다).
const BLOCKED_BEFORE_PROVIDER_KINDS: ReadonlySet<SitePostApiErrorKind> = new Set([
  'rate_limited', 'token_expired', 'connection_not_active', 'approver_role_missing',
  'permission', 'publish_in_progress', 'text_too_long', 'approval_required',
  'seal_missing', 'reapproval_required', 'resubmit_required', 'gate_already_held',
]);

/**
 * 오류의 kind(parseSitePostApiError가 이미 판정)를 근거로 "Threads 쪽으로 실제 요청이
 * 나갔는가"를 판정한다. kind==='provider_error'(CHANNEL_PUBLISH_PROVIDER_ERROR, 502)만
 * provider에 도달한 뒤 실패한 것이고, AC10 표의 나머지 11개 kind는 전부 그 관문 이전에서
 * 멈춘 것 — Threads 계정에 흔적이 남을 수 없다. kind==='unknown'(매핑표에 없는 모든
 * 코드 — 500/503/504·BFF 400·미지 코드 포함)은 **fail-closed로 'unknown'을 낸다** — 모르는
 * 것을 "안 나갔다"로 단정하지 않는다(§17-4).
 */
export function describeExternalImpact(kind: SitePostApiErrorKind | undefined): ExternalImpact {
  if (kind === 'provider_error') return 'reached_provider';
  if (kind !== undefined && BLOCKED_BEFORE_PROVIDER_KINDS.has(kind)) return 'not_sent';
  return 'unknown';
}
