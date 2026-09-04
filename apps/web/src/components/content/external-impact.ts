// story #3402(Phase1·마케팅운영, doc §5 각주·AC11) — "막혔다"와 "밖으로 나갔다"는 다르다.
// http_status가 null인 응답은 "모른다"가 아니라 "HTTP 실패 자체가 없었다"는 뜻이다(§5
// 각주 원문): ①서버가 200을 주었는데 내용이 거부된 것(통신은 성공, 판정이 막음) ②네트워크를
// 아예 타지 않은 로컬 입력 검증. 이 구분이 §5-1(「막혔다」≠「밖으로 나갔다」)의 근거다 —
// null을 "모름"으로 읽으면 화면이 있지도 않은 외부 호출 실패를 찾게 된다.
export type ExternalImpact = 'not_sent' | 'reached_provider';

/**
 * httpStatus(발행 시도 응답의 실제 HTTP status, 로컬 검증 등으로 네트워크를 안 탔으면 null)를
 * 근거로 "Threads 쪽으로 실제 요청이 나갔는가"를 판정한다. 502(CHANNEL_PUBLISH_PROVIDER_ERROR)
 * 만 provider에 도달한 뒤 실패한 것이고, 나머지(4xx·429·null)는 전부 그 관문 이전에서 멈춘
 * 것이다 — Threads 계정에 흔적이 남을 수 없다.
 *
 * 209/일시 provider 5xx(예: 503)도 향후 코드가 늘면 이 표를 넓혀야 한다 — 지금은 doc §5
 * 12행 표에 실재하는 502 하나만 "도달함"으로 분류한다(표에 없는 값을 지어내지 않는다).
 */
export function describeExternalImpact(httpStatus: number | null | undefined): ExternalImpact {
  if (httpStatus === 502) return 'reached_provider';
  return 'not_sent';
}
