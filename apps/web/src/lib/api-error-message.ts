/**
 * story #2647(공통화, PO 재량 지시) — story #2637 §범위3의 EventPublishActionButton이 먼저
 * 세운 패턴("BE가 이유를 완성 문장으로 주므로 FE가 재구성하지 않고 그대로 보여준다")을
 * 여기로 뽑아 DeliveryContractModal(#2647)과 공유한다. BE 에러 응답은 두 모양이 섞여 있다
 * (apiSuccess()가 감싼 `{error:{message}}`·FastAPI HTTPException을 그대로 통과시키는
 * `{detail: string | {message: string}}`) — 이 함수는 그 세 자리를 순서대로 본다.
 * 못 찾으면 null(호출부가 자기 폴백 문구를 쓴다 — 이 함수는 "찾았는지"만 정직하게 답한다).
 */
export function extractBackendErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { error?: { message?: unknown }; detail?: unknown };
  if (typeof b.error?.message === 'string') return b.error.message;
  if (typeof b.detail === 'string') return b.detail;
  if (b.detail && typeof b.detail === 'object' && typeof (b.detail as { message?: unknown }).message === 'string') {
    return (b.detail as { message: string }).message;
  }
  return null;
}
