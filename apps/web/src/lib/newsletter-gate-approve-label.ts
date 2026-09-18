// story #3813(Phase3·3-4 PR4, 페드루 PO 確定 2026-09-12·CHANGES 2026-09-12 라이브
// 캡처 실측) — 「발행」(ESP 캠페인 생성)과 「발송」이 같은 승인 버튼(또는 서명 플로우
// 변형)을 공유하면 두 서로 다른 행위가 같은 낱말("승인")로 뭉개진다. 이 판별을
// 한 곳에만 둔다 — gates/[id]/page.tsx(저위험 평문 버튼)·gate-signature-approval.tsx
// (고위험 서명 플로우)·approvals-queue.tsx(인박스 카드) 셋 다 같은 게이트가 다른
// 화면에 떠도 같은 낱말을 써야 한다(CHANGES 실측 — 처음엔 평문 버튼에만 붙여
// 정작 사람이 누르는 서명 버튼엔 안 붙는 결함이 났다).
//
// ⚠️CHANGES(2026-09-12) — 승인=게이트 승인일 뿐(캠페인 실제 생성은 별도 발행하기
// 버튼이 한다) — "만들기"류 낱말은 이 판별에 안 쓴다("캠페인 승인"이 맞다).
export type NewsletterGateKind = 'newsletter_send' | 'newsletter_campaign' | null;

export function newsletterGateKind(
  gate: { gate_type?: string | null; sealed_destination_channel?: string | null } | null | undefined,
): NewsletterGateKind {
  if (!gate) return null;
  if (gate.gate_type === 'newsletter_send') return 'newsletter_send';
  if (
    gate.gate_type === 'external_publish'
    && (gate.sealed_destination_channel === 'stibee' || gate.sealed_destination_channel === 'stibee_sandbox')
  ) {
    return 'newsletter_campaign';
  }
  return null;
}

/** 저위험 평문 승인 버튼(gateApprove)의 낱말 분리. */
export function gateApproveLabelKey(
  gate: { gate_type?: string | null; sealed_destination_channel?: string | null } | null | undefined,
): string {
  const kind = newsletterGateKind(gate);
  if (kind === 'newsletter_send') return 'gateApproveNewsletterSend';
  if (kind === 'newsletter_campaign') return 'gateApproveCampaign';
  return 'gateApprove';
}

/** 고위험 서명 플로우 버튼(sigApproveAndSign)의 낱말 분리 — 「서명」 낱말은 유지. */
export function sigApproveAndSignLabelKey(
  gate: { gate_type?: string | null; sealed_destination_channel?: string | null } | null | undefined,
): string {
  const kind = newsletterGateKind(gate);
  if (kind === 'newsletter_send') return 'sigApproveAndSignNewsletterSend';
  if (kind === 'newsletter_campaign') return 'sigApproveAndSignCampaign';
  return 'sigApproveAndSign';
}
