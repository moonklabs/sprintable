/**
 * story #3845(우패널·주 액션, 페드루 PO 확定 2026-09-14 08:26Z) — 순수 판정 함수만(fetch 0,
 * derive-work-list.ts와 동일 분리 원칙: 파생 로직은 렌더와 떼어 테스트한다).
 *
 * 정정(2026-09-14 09:11Z, 페드루 PO 리뷰 CHANGES②) — 초안의 `primaryActionLabelKey`는
 * `gate_type === 'external_publish' || risk_grade === 'high'`를 독자 재구현했는데, 이건
 * `apps/web/src/components/cage/gate-risk.ts::usesSignatureFlow(deriveRiskLevel(gate))`
 * (gates/[id]/page.tsx의 `isSigFlowGate`가 실제로 쓰는 그 SSOT)와 미묘하게 달랐다 — 실
 * 버그: `risk_grade === null`(미분류·구버전 응답)을 `deriveRiskLevel`은 `'unknown'`으로
 * 보수적 고위험 취급하는데, 옛 OR-조건은 그 케이스를 평문 「승인」으로 잘못 흘려보냈다
 * (오르테가군 판정 — "위험도를 모르면 고위험 취급", gate-risk.ts 자체 주석 참고). 라벨
 * 판정을 그 SSOT의 얇은 함수로 되돌린다 — 독자 재구현 0.
 */
import type { GateItem } from '@/components/kanban/types';
import { deriveRiskLevel, usesSignatureFlow } from '@/components/cage/gate-risk';
import type { WorkList, WorkListRow } from './derive-work-list';

/** GET /api/v2/gates 응답(GateResponse)을 그대로 GateItem으로 쓴다(하위집합 재정의 0 —
 * GateSignatureApproval·GateEvidence 등 기존 컴포넌트가 전부 GateItem을 요구하므로, 이
 * 패널이 자기만의 좁은 타입을 유지하면 그 컴포넌트들과 타입이 안 맞아 재구현을 유발한다). */
export type WorkListGate = GateItem;

export type PrimaryActionLabelKey = 'actionApprove' | 'actionApproveAndSign';

/** ⭐뮤테이션 표적 — «승인」/«승인하고 서명」 갈림 자체가 이 함수 하나다. gate-risk.ts의
 * usesSignatureFlow(deriveRiskLevel(gate))를 그대로 재사용(재구현 0) — 「서명 대기」
 * 상태(gates/[id]/page.tsx의 isSigFlowGate)와 이 라벨이 다른 조건이면 그 자체가 사용자
 * 에게 거짓말이 된다. */
export function primaryActionLabelKey(gate: GateItem): PrimaryActionLabelKey {
  return usesSignatureFlow(deriveRiskLevel(gate)) ? 'actionApproveAndSign' : 'actionApprove';
}

/** 위험 pill+문장은 risk_grade가 실제로 있을 때만(gate_type/risk에서만 — PO 明示, 없으면
 * 렌더 0이지 placeholder가 아니다).
 *
 * 픽셀 커밋 CHANGES 3(페드루 PO 판정 2026-09-14 09:40Z) — 저위험은 문장 0(pill이 이미
 * 「저위험」이라 말하는 사실을 문장으로 두 번 말하지 않는다·pill+문장 중복 제거). 고위험
 * 문장은 "근거를 확認해 주세요"류 지시문이 아니라 «되돌릴 수 없음»(비가역성) 사실 진술로 —
 * pill 옆에서 "이건 왜 조심해야 하나"를 한 줄로 답한다. */
export function riskSentenceKey(gate: Pick<GateItem, 'risk_grade'>): 'riskSentenceHigh' | null {
  return gate.risk_grade === 'high' ? 'riskSentenceHigh' : null;
}

/** 픽셀 커밋 CHANGES 3(c) — high→destructive(빨강)는 §③ 토큰 표에 없는 색(이 프로젝트의
 * 위험/경고 축은 amber 하나뿐, red는 파괴적 액션 전용 — risk badge가 그 축을 잘못
 * 빌려 썼던 것). high·low 둘 다 warning(amber) 하나로 — 「저위험/고위험」 구분은 pill의
 * 낱말 자체(chipLowRisk/riskBadgeHigh)가 이미 하므로 색까지 나눌 필요가 없다. */
export function riskBadgeVariant(gate: Pick<GateItem, 'risk_grade'>): 'warning' | null {
  return gate.risk_grade === 'high' || gate.risk_grade === 'low' ? 'warning' : null;
}

/** story #3845·3860 AC2 — 「답하기」는 conversation_id가 있을 때만(없으면 비노출).
 * story #3860(BE PR #4273)이 GateResponse·kanban/types.ts::GateItem에 conversation_id
 * 필드를 추가했지만, 이 브랜치가 rebase된 시점(develop d841776573) 기준 #4273은 아직
 * develop에 안 착지했다 — GateItem 타입 자체에 이 필드가 없다. 착지 前에도 컴파일 가능하게
 * 구조적 읽기(런타임엔 필드가 있으면 값을, 없으면 undefined→null)로 두고, #4273 rebase
 * 뒤 `GateItem['conversation_id']`가 실제로 선언되면 이 캐스트를 걷고 `gate.conversation_id`
 * 직접 읽기로 단순화한다(그 전까지도 동작은 이미 정확 — 타입만 과도기).
 */
export function gateConversationId(gate: unknown): string | null {
  const raw = (gate as { conversation_id?: string | null } | null | undefined)?.conversation_id;
  return raw ?? null;
}

// ─── story #3845 픽셀 커밋 ①(페드루 PO 판정 2026-09-14 09:11Z) — 필터 가려진 행 ?row= 딥링크 ───
//
// "URL이 SSOT" — 필터로 안 보이는 행이라도 ?row=로 열면 패널은 뜬다(안내 배너+필터 지우기
// 버튼과 함께). 그래서 패널의 데이터 소스는 filtered(화면에 보이는 목록)가 아니라
// data(필터 前 전체 트리)여야 한다 — findSelectedRowContext가 그 축, isRowVisibleInFiltered가
// "지금 화면에도 보이는가"를 별도로 잰다(두 축이 다른 이유: 전자는 패널 존재 여부, 후자는
// 배너 노출 여부).

export interface SelectedRowContext {
  row: WorkListRow;
  goalTitle: string;
  storyId: string;
  storyTitle: string;
}

/** 필터 前 전체 트리(data)에서 selectedRowId를 찾는다 — filtered가 아니라 data를 순회하는
 * 것 자체가 ①의 근본수정(필터로 걸러진 행도 패널은 뜬다). */
export function findSelectedRowContext(data: WorkList | null, selectedRowId: string | null): SelectedRowContext | null {
  if (!selectedRowId || !data) return null;
  for (const group of data.groups) {
    for (const story of group.stories) {
      const row = story.rows.find((r) => r.id === selectedRowId);
      if (row) return { row, goalTitle: group.title, storyId: story.storyId, storyTitle: story.title };
    }
  }
  return null;
}

/** 그 행이 "지금 필터가 걸린 화면"에도 보이는가 — false면 패널에 안내 배너를 띄운다. */
export function isRowVisibleInFiltered(filtered: WorkList | null, rowId: string): boolean {
  if (!filtered) return false;
  return filtered.groups.some((g) => g.stories.some((s) => s.rows.some((r) => r.id === rowId)));
}
