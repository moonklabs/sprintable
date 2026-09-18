// story #2043 — 게이트 상세 화면 자기모순("Review needed"이면서 동시에 "Auto-passed") 회귀 방지.
//
// 실측 재현 조합(story #2043 API 대조): status='pending' · requires_human=false ·
// auto_decision_reason 없음(POST /api/v2/gates 직접 생성 경로는 판정 알고리즘을 안 거쳐
// requires_human을 기본값 false로 남긴다) — 이 조합에서 gateDecision()이 예전엔 무조건
// 'ask_human'을 리턴해 GateEvidence 배지가 "Review needed"를 말하는 동안, gates/[id]/page.tsx의
// 별도 읽기전용 텍스트는 "decision !== 'block'"만 보고 "Auto-passed"를 말했다 — 한 화면이
// 반대되는 두 문장을 동시에 냈다.
import { describe, expect, it } from 'vitest';
import { gateDecision, gateHasEvidence, gateNeedsAction, githubCheckState } from './gate-evidence';
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

// story #2814 — GitHub check 상태 파생. BE gate_github_check.py::_github_state_for_gate_status와
// 정합해야 한다(approved/auto_passed→success, rejected/voided→failure, pending/held→in_progress).
describe('githubCheckState (story #2814)', () => {
  it('github_check_run_id가 null이면 발행 안 됨/관측모드 둘 다 구분 못 하므로 null(표시 접음)이다', () => {
    const gate = baseGate({ status: 'approved', github_check_run_id: null });
    expect(githubCheckState(gate)).toBeNull();
  });

  it('github_check_run_id undefined(구버전 응답)도 동일하게 null이다', () => {
    const gate = baseGate({ status: 'approved' });
    expect(githubCheckState(gate)).toBeNull();
  });

  it.each([
    ['approved', 'success'],
    ['auto_passed', 'success'],
    ['rejected', 'failure'],
    ['voided', 'failure'],
    ['pending', 'in_progress'],
    ['held', 'in_progress'],
  ] as const)('status=%s + check 발행됨 → %s', (status, expected) => {
    const gate = baseGate({ status, github_check_run_id: 12345 });
    expect(githubCheckState(gate)).toBe(expected);
  });

  it('check가 발행됐어도 gate status가 discussed 등 미정의 상태면 null이다', () => {
    const gate = baseGate({ status: 'discussed', github_check_run_id: 12345 });
    expect(githubCheckState(gate)).toBeNull();
  });
});

describe('gateHasEvidence — GitHub check 단독 신호도 실 증거로 친다(story #2814)', () => {
  it('CI/신뢰도/사유 전부 없어도 GitHub check가 발행됐으면 evidence 있음(State A로 안 가라앉음)', () => {
    const gate = baseGate({ status: 'pending', github_check_run_id: 12345, neutral_facts: null });
    expect(gateHasEvidence(gate)).toBe(true);
  });

  it('GitHub check도 없고 다른 신호도 전부 없으면 여전히 evidence 없음(기존 동작 보존)', () => {
    const gate = baseGate({ status: 'pending', neutral_facts: null });
    expect(gateHasEvidence(gate)).toBe(false);
  });

  // story #2862 — hypothesis_outcome_confirm 게이트는 ci/trust/cold_start_seed가 전혀 없어
  // draft_target 신호가 없으면 gateHasEvidence가 false로 착시(=State A 빈 카드로 가라앉아
  // 사람이 판정 초안을 아예 못 봄)를 회귀 가드.
  it('draft_target이 있으면(다른 신호 전무여도) evidence 있음 — hypothesis_outcome_confirm 게이트가 State A로 안 가라앉는다', () => {
    const gate = baseGate({
      gate_type: 'hypothesis_outcome_confirm', status: 'pending',
      neutral_facts: { draft_target: 'verified', draft_actual: 42, draft_reason: 'X' },
    });
    expect(gateHasEvidence(gate)).toBe(true);
  });

  it('draft_target이 계약 밖 값이면 evidence로 안 친다(no-fiction — 방어)', () => {
    const gate = baseGate({
      gate_type: 'hypothesis_outcome_confirm', status: 'pending',
      neutral_facts: { draft_target: 'unknown' },
    });
    expect(gateHasEvidence(gate)).toBe(false);
  });
});

// story #3328(3바퀴 라이브 결함 · db967a77) — 레시피 approve 게이트(external_publish, BE
// recipe_gate_hooks.py::_build_approval_neutral_facts)의 neutral_facts도 실 증거다. 이 신호가
// 하나도 안 잡혀 gate 09631e56(실사고 재현) 같은 게이트가 CI/신뢰도/사유/GitHub check/draft_target
// 전무라는 이유만으로 State A(«근거 데이터 없음»)로 가라앉았다 — «내용으로 직접 판단» 문구
// 자체가 승인 대상(draft doc·channel)조차 못 보여준다는 점에서 다른 신호 부재와 근본적으로
// 다르다(사람이 뭘 승인하는지 화면 안에서 전혀 알 길이 없었다).
describe('gateHasEvidence — 레시피 approve 게이트 neutral_facts(story #3328)', () => {
  it('work_item_reference_token·draft_doc_reference_token·channel이 있으면 evidence 있음', () => {
    const gate = baseGate({
      gate_type: 'external_publish', status: 'pending',
      neutral_facts: {
        work_item_title: '9월 캠페인', work_item_reference_token: '[9월 캠페인](entity:story:s-1)',
        channel: 'threads', draft_doc_reference_token: '[캠페인 초안](entity:doc:d-1)',
        draft_doc_summary: '초안 본문', stage: 'approve',
      },
    });
    expect(gateHasEvidence(gate)).toBe(true);
  });

  it('전 필드가 BE sentinel "미확認"이면 evidence 없음(지어내지 않음 — 진짜 빈 카드는 여전히 State A)', () => {
    const gate = baseGate({
      gate_type: 'external_publish', status: 'pending',
      neutral_facts: {
        work_item_title: '미확認', work_item_reference_token: '미확認', channel: '미확認',
        draft_doc_reference_token: '미확認', draft_doc_summary: '미확認',
      },
    });
    expect(gateHasEvidence(gate)).toBe(false);
  });

  it('channel 하나만 있어도(다른 필드 전부 미확認/부재) evidence 있음 — 부분증거도 실 증거', () => {
    const gate = baseGate({
      gate_type: 'external_publish', status: 'pending',
      neutral_facts: { channel: 'threads' },
    });
    expect(gateHasEvidence(gate)).toBe(true);
  });
});

// story #2814 2단(§5-④ 그라운딩·BE story #2815/PR#3245) — 관측모드 판별을 github_check_enforced
// 필드 기반으로 승격. BE는 단건 조회(get_gate_endpoint)에서만 이 필드를 enrich한다.
describe('githubCheckState — github_check_enforced 기반 승격(story #2814 2단)', () => {
  it('enforced===false(관측모드 확定)면 run_id가 있어도 항상 숨김(가장 신뢰도 높은 신호가 우선)', () => {
    const gate = baseGate({ status: 'approved', github_check_run_id: 12345, github_check_enforced: false });
    expect(githubCheckState(gate)).toBeNull();
  });

  it('enforced===true인데 run_id가 아직 null이면 "관측모드"가 아니라 not_published로 승격 표시(1단엔 없던 상태)', () => {
    const gate = baseGate({ status: 'pending', github_check_run_id: null, github_check_enforced: true });
    expect(githubCheckState(gate)).toBe('not_published');
  });

  it('enforced가 undefined인 표면(list_gates/inbox 등 미enrich)은 1단 run_id 휴리스틱 그대로 폴백', () => {
    const gate = baseGate({ status: 'pending', github_check_run_id: null });
    expect(githubCheckState(gate)).toBeNull();
  });

  it('enforced===true + run_id 있으면 기존 status 매핑 그대로(1단 회귀 없음)', () => {
    const gate = baseGate({ status: 'approved', github_check_run_id: 12345, github_check_enforced: true });
    expect(githubCheckState(gate)).toBe('success');
  });
});
