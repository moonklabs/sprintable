import { describe, expect, it } from 'vitest';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';

// story #4558(유나 AC0 정본 §1 · §4) — 누른 단추 낱말 == 결과 머리 어간(반려→반려됨 · 승인→승인됨 · 보류→보류됨), ko·en 둘 다.
// 진입 [반려](gateReject) · 패널 [반려](sigReject) · 결과 «반려됨»(gateStatusRejected)이 한 낱말. 옛 «변경 요청» 키(sigRequestChanges)는 없다.
describe('게이트 결정 낱말 — 단추 == 결과 어간(story #4558)', () => {
  const ko = koMessages.cage as Record<string, string>;
  const en = enMessages.cage as Record<string, string>;

  it('ko: 진입 [반려] == 패널 [반려] · 반려→반려됨 · 승인하고 서명→승인됨 · 보류(논의 필요)→보류됨', () => {
    expect(ko.sigReject).toBe('반려');
    expect(ko.gateReject).toBe(ko.sigReject);
    expect(ko.gateStatusRejected).toBe(`${ko.sigReject}됨`);
    expect(ko.sigApproveAndSign.startsWith('승인')).toBe(true);
    expect(ko.gateStatusApproved).toBe('승인됨');
    expect(ko.gateDiscussSubmit.startsWith('보류')).toBe(true);
    expect(ko.gateStatusHeld).toBe('보류됨');
  });

  it('en: Reject == Reject · Reject→Rejected · Approve & sign→Approved', () => {
    expect(en.sigReject).toBe('Reject');
    expect(en.gateReject).toBe(en.sigReject);
    expect(en.gateStatusRejected).toBe('Rejected');
    expect(en.sigApproveAndSign).toBe('Approve & sign');
    expect(en.gateStatusApproved).toBe('Approved');
  });

  it('옛 «변경 요청» 키는 결정 패널 낱말 집합에 없다(죽은 키 0 · 되살리면 RED)', () => {
    expect(ko.sigRequestChanges).toBeUndefined();
    expect(en.sigRequestChanges).toBeUndefined();
  });

  it('눈썹 세 묶음 글이 ko·en에 있다(proofCapsule.claim)', () => {
    const koClaim = (koMessages.proofCapsule as { claim: Record<string, string> }).claim;
    const enClaim = (enMessages.proofCapsule as { claim: Record<string, string> }).claim;
    expect(koClaim.decisionRequestLabel).toBe('에이전트 질문 · 판단을 기다려요');
    expect(koClaim.goAheadLabel).toBe('진행 승인 · 이대로 진행할지 결정해요');
    expect(koClaim.publishApprovalLabel).toBe('발행 승인 · 이대로 발행할지 결정해요');
    expect(enClaim.decisionRequestLabel).toBe('Agent question · Waiting for your decision');
    expect(enClaim.goAheadLabel).toBe('Go-ahead · Decide whether to proceed as is');
  });
});
