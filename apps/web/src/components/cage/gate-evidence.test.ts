// story #2043 — 게이트 상세 화면 자기모순("Review needed"이면서 동시에 "Auto-passed") 회귀 방지.
//
// 실측 재현 조합(story #2043 API 대조): status='pending' · requires_human=false ·
// auto_decision_reason 없음(POST /api/v2/gates 직접 생성 경로는 판정 알고리즘을 안 거쳐
// requires_human을 기본값 false로 남긴다) — 이 조합에서 gateDecision()이 예전엔 무조건
// 'ask_human'을 리턴해 GateEvidence 배지가 "Review needed"를 말하는 동안, gates/[id]/page.tsx의
// 별도 읽기전용 텍스트는 "decision !== 'block'"만 보고 "Auto-passed"를 말했다 — 한 화면이
// 반대되는 두 문장을 동시에 냈다.
import { describe, expect, it } from 'vitest';
import { gateDecision, gateNeedsAction } from './gate-evidence';
import type { GateItem } from '@/components/kanban/types';

function baseGate(overrides: Partial<GateItem>): GateItem {
  return {
    id: 'gate-1',
    work_item_id: 'wi-1',
    work_item_type: 'story',
    gate_type: 'merge',
    status: 'pending',
    resolver_id: null,
    resolved_at: null,
    resolution_note: null,
    neutral_facts: null,
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

describe('gateDecision — story #2043 판정 미거침 조합', () => {
  it('story #2043 실측 조합(pending·requires_human=false·판정 없음)은 ask_human이 아니라 null(판정 정보 없음)이다', () => {
    const gate = baseGate({ status: 'pending', requires_human: false, auto_decision_reason: null });
    expect(gateDecision(gate)).toBeNull();
  });

  it('pending·requires_human=true·판정 없음은 여전히 ask_human이다(기존 동작 보존)', () => {
    const gate = baseGate({ status: 'pending', requires_human: true, auto_decision_reason: null });
    expect(gateDecision(gate)).toBe('ask_human');
  });

  it('auto_decision_reason이 명시돼 있으면 requires_human과 무관하게 그 값을 그대로 신뢰한다', () => {
    const gate = baseGate({ status: 'pending', requires_human: false, auto_decision_reason: 'auto_merge' });
    expect(gateDecision(gate)).toBe('auto_merge');
  });

  it('gateNeedsAction은 requires_human만으로 판정되어(gateDecision 변경과 독립) 회귀가 없다', () => {
    const needsAction = baseGate({ status: 'pending', requires_human: true, auto_decision_reason: null });
    const noAction = baseGate({ status: 'pending', requires_human: false, auto_decision_reason: null });
    expect(gateNeedsAction(needsAction)).toBe(true);
    expect(gateNeedsAction(noAction)).toBe(false);
  });

  it('resolved(status≠pending) 게이트는 auto_decision_reason 없이는 null — 해소 문구는 status 자체로 별도 처리되므로 여기서 auto/ask를 지어내지 않는다', () => {
    const gate = baseGate({ status: 'approved', requires_human: true, auto_decision_reason: null });
    expect(gateDecision(gate)).toBeNull();
  });
});
