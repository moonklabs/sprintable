import { describe, expect, it } from 'vitest';
import { gateApproveLabelKey, newsletterGateKind, sigApproveAndSignLabelKey } from './newsletter-gate-approve-label';

// story #3813(Phase3·3-4 PR4, 페드루 PO 確定+CHANGES 2026-09-12) — 이 판별이 한
// 곳(이 파일)에만 살아야 gates/[id]/page.tsx·gate-signature-approval.tsx·
// approvals-queue.tsx 셋이 절대 갈리지 않는다(CHANGES 실측 — 처음엔 첫 번째
// 소비처에만 적용해 두 번째가 놓쳤다).
describe('newsletterGateKind', () => {
  it('gate_type=newsletter_send이면 그 값 그대로', () => {
    expect(newsletterGateKind({ gate_type: 'newsletter_send' })).toBe('newsletter_send');
  });

  it('gate_type=external_publish + stibee/stibee_sandbox면 newsletter_campaign', () => {
    expect(newsletterGateKind({ gate_type: 'external_publish', sealed_destination_channel: 'stibee' })).toBe('newsletter_campaign');
    expect(newsletterGateKind({ gate_type: 'external_publish', sealed_destination_channel: 'stibee_sandbox' })).toBe('newsletter_campaign');
  });

  it('gate_type=external_publish + 다른 채널이면 null(뉴스레터 아님)', () => {
    expect(newsletterGateKind({ gate_type: 'external_publish', sealed_destination_channel: 'threads' })).toBeNull();
  });

  it('gate가 null/undefined면 null(fail-closed)', () => {
    expect(newsletterGateKind(null)).toBeNull();
    expect(newsletterGateKind(undefined)).toBeNull();
  });

  it('그 외 gate_type은 null', () => {
    expect(newsletterGateKind({ gate_type: 'ads_boost' })).toBeNull();
    expect(newsletterGateKind({ gate_type: 'doc_approval' })).toBeNull();
  });
});

describe('gateApproveLabelKey — 저위험 평문 버튼 낱말', () => {
  it('newsletter_send → gateApproveNewsletterSend', () => {
    expect(gateApproveLabelKey({ gate_type: 'newsletter_send' })).toBe('gateApproveNewsletterSend');
  });

  it('뉴스레터 캠페인 → gateApproveCampaign(만들기 아님, CHANGES 정정)', () => {
    expect(gateApproveLabelKey({ gate_type: 'external_publish', sealed_destination_channel: 'stibee_sandbox' })).toBe('gateApproveCampaign');
  });

  it('그 외 → 기존 gateApprove', () => {
    expect(gateApproveLabelKey({ gate_type: 'external_publish', sealed_destination_channel: 'threads' })).toBe('gateApprove');
    expect(gateApproveLabelKey({ gate_type: 'ads_boost' })).toBe('gateApprove');
  });
});

describe('sigApproveAndSignLabelKey — 고위험 서명 플로우 버튼 낱말(실 뉴스레터 게이트가 타는 실제 경로)', () => {
  it('newsletter_send → sigApproveAndSignNewsletterSend', () => {
    expect(sigApproveAndSignLabelKey({ gate_type: 'newsletter_send' })).toBe('sigApproveAndSignNewsletterSend');
  });

  it('뉴스레터 캠페인 → sigApproveAndSignCampaign', () => {
    expect(sigApproveAndSignLabelKey({ gate_type: 'external_publish', sealed_destination_channel: 'stibee' })).toBe('sigApproveAndSignCampaign');
  });

  it('그 외 → 기존 sigApproveAndSign(「서명」 낱말 유지)', () => {
    expect(sigApproveAndSignLabelKey({ gate_type: 'doc_approval' })).toBe('sigApproveAndSign');
  });
});
