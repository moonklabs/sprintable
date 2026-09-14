import { describe, expect, it } from 'vitest';
import {
  findSelectedRowContext, gateConversationId, isRowVisibleInFiltered, primaryActionLabelKey,
  riskBadgeVariant, riskSentenceKey, type WorkListGate,
} from './work-list-detail-actions';
import type { WorkList, WorkListRow } from './derive-work-list';

function gate(overrides: Partial<WorkListGate> = {}): WorkListGate {
  return {
    id: 'g1', gate_type: 'doc_approval', risk_grade: null, status: 'pending',
    work_item_id: 's1', work_item_type: 'story',
    resolver_id: null, resolved_at: null, resolution_note: null, neutral_facts: null,
    created_at: '2026-09-14T00:00:00Z', updated_at: '2026-09-14T00:00:00Z',
    ...overrides,
  };
}

describe('primaryActionLabelKey — gate-risk.ts::usesSignatureFlow(deriveRiskLevel(gate)) 재사용(재구현 0)', () => {
  // 정정(2026-09-14 09:11Z, 페드루 PO 리뷰) — 옛 독자 OR-조건은 risk_grade=null을
  // "저위험"으로 잘못 취급했다. 실 SSOT(gate-risk.ts)는 null(미분류)을 'unknown'으로
  // 매핑해 보수적 고위험 취급한다 — 이 테이블이 그 정정을 고정한다.
  it('⭐전수 — gate_type/risk_grade 조합', () => {
    const cases: Array<[Partial<WorkListGate>, ReturnType<typeof primaryActionLabelKey>]> = [
      [{ gate_type: 'doc_approval', risk_grade: 'low' }, 'actionApprove'],
      [{ gate_type: 'merge', risk_grade: 'low' }, 'actionApprove'],
      [{ gate_type: 'artifact_canonicalize', risk_grade: 'low' }, 'actionApprove'],
      [{ gate_type: 'doc_approval', risk_grade: 'high' }, 'actionApproveAndSign'],
      // ⭐이 카드가 이 세션에서 고친 정확한 버그 — risk_grade=null(미분류)은 gate_type과
      // 무관하게 항상 서명 플로우(usesSignatureFlow('unknown') === true, 'low'만 제외).
      [{ gate_type: 'doc_approval', risk_grade: null }, 'actionApproveAndSign'],
      [{ gate_type: 'merge', risk_grade: null }, 'actionApproveAndSign'],
      [{ gate_type: 'external_publish', risk_grade: null }, 'actionApproveAndSign'],
      [{ gate_type: 'external_publish', risk_grade: 'low' }, 'actionApprove'],
    ];
    for (const [overrides, expected] of cases) {
      expect(primaryActionLabelKey(gate(overrides)), JSON.stringify(overrides)).toBe(expected);
    }
  });

  it('⭐뮤테이션 표적 확認 — risk_grade=low만 평문(그 밖은 전부 서명), gate_type은 라벨 판정에 안 쓰인다', () => {
    // gate_type을 external_publish로 바꿔도 risk_grade='low'면 평문이어야 한다(옛 OR-조건은
    // 여기서 반대로 틀렸었다 — gate_type만으로 서명을 강제하지 않는다는 게 실 SSOT).
    expect(primaryActionLabelKey(gate({ gate_type: 'external_publish', risk_grade: 'low' }))).toBe('actionApprove');
  });
});

describe('riskSentenceKey/riskBadgeVariant — gate_type/risk에서만(PO 明示, null이면 렌더 0)', () => {
  it('risk_grade=null이면 둘 다 null(placeholder 0)', () => {
    expect(riskSentenceKey(gate({ risk_grade: null }))).toBeNull();
    expect(riskBadgeVariant(gate({ risk_grade: null }))).toBeNull();
  });

  it('risk_grade=high → warning 뱃지(§③ 빨강 토큰 0)+비가역성 문장', () => {
    expect(riskSentenceKey(gate({ risk_grade: 'high' }))).toBe('riskSentenceHigh');
    expect(riskBadgeVariant(gate({ risk_grade: 'high' }))).toBe('warning');
  });

  it('⭐risk_grade=low → warning 뱃지지만 문장은 0(pill과 같은 사실 두 번 말하지 않는다, CHANGES 3b)', () => {
    expect(riskSentenceKey(gate({ risk_grade: 'low' }))).toBeNull();
    expect(riskBadgeVariant(gate({ risk_grade: 'low' }))).toBe('warning');
  });
});

describe('gateConversationId — 3860 AC2(BE #4273 착지 前 구조적 읽기 shim)', () => {
  it('conversation_id 필드가 있으면 그 값', () => {
    expect(gateConversationId({ id: 'g1', conversation_id: 'conv-1' })).toBe('conv-1');
  });

  it('필드가 없거나 null이면 null(지어내지 않는다)', () => {
    expect(gateConversationId(gate())).toBeNull();
    expect(gateConversationId({ id: 'g1', conversation_id: null })).toBeNull();
    expect(gateConversationId(null)).toBeNull();
    expect(gateConversationId(undefined)).toBeNull();
  });

  it('⭐뮤테이션 표적 확認 — 읽는 필드명이 정확히 conversation_id다(다른 이름은 안 읽음)', () => {
    expect(gateConversationId({ id: 'g1', convo_id: 'wrong-field' })).toBeNull();
  });
});

// ─── 픽셀 커밋 ①(페드루 PO 판정 2026-09-14 09:11Z) — 필터 가려진 행 ?row= 딥링크 ───

function row(id: string): WorkListRow {
  return {
    id, kind: 'task', workItemType: 'task', workItemId: id,
    title: `일 ${id}`, ownerName: null, isDelegated: false, lowRisk: false, artifactCount: 0,
    state: null,
  };
}

function workList(rowIds: string[]): WorkList {
  return {
    partial: false,
    groups: [{
      goalId: 'goal-1', title: '목표 A', isActive: true, doneCount: 0, totalCount: rowIds.length,
      assignedCount: 0, delegatedCount: 0, hypothesisCount: 0,
      stories: [{ storyId: 'story-1', title: '스토리 A', hypothesisIds: [], rows: rowIds.map(row) }],
    }],
  };
}

describe('findSelectedRowContext — data(필터 前 트리)에서 찾는다(filtered 아님)', () => {
  it('data에 있으면 찾는다(row·goalTitle·storyId·storyTitle 전부)', () => {
    const ctx = findSelectedRowContext(workList(['r1', 'r2']), 'r2');
    expect(ctx?.row.id).toBe('r2');
    expect(ctx?.goalTitle).toBe('목표 A');
    expect(ctx?.storyId).toBe('story-1');
    expect(ctx?.storyTitle).toBe('스토리 A');
  });

  it('selectedRowId가 null이거나 data가 null이면 null', () => {
    expect(findSelectedRowContext(workList(['r1']), null)).toBeNull();
    expect(findSelectedRowContext(null, 'r1')).toBeNull();
  });

  it('⭐data에 없는 id는 null(존재하지 않는 행을 지어내지 않는다)', () => {
    expect(findSelectedRowContext(workList(['r1']), 'ghost')).toBeNull();
  });
});

describe('isRowVisibleInFiltered — filtered(화면에 보이는 목록)에도 있는가', () => {
  it('filtered에 있으면 true', () => {
    expect(isRowVisibleInFiltered(workList(['r1', 'r2']), 'r2')).toBe(true);
  });

  it('⭐filtered에서 걸러졌으면(더 좁은 목록) false — 이 경우가 배너를 띄우는 신호', () => {
    const narrowed = workList(['r1']); // r2는 필터로 걸러진 상태를 흉내
    expect(isRowVisibleInFiltered(narrowed, 'r2')).toBe(false);
  });

  it('filtered가 null이면 false(아직 안 불러왔거나 로드 실패)', () => {
    expect(isRowVisibleInFiltered(null, 'r1')).toBe(false);
  });
});
