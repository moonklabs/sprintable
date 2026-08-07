/**
 * story #2262 PR②(AC2 나머지) — 참조 칩 자체(모달 열기 前)에 보일 「지금 상태」의 번역·판정
 * 로직. 배치조회 배선(chat-view.tsx, BE `?ids=` 대기 — 디디군 협업 중)보다 먼저 짜는 순수
 * 로직 골격(PO 지시 2026-08-07: "번역맵·prop 스레딩 골격은 미리 짜둬도 되고, BE 계약은
 * story `?ids=` 형태 그대로일 테니").
 */

/** AC2 실측(2026-07-30, sprintable-verify-oneoff) 그대로의 실 DB 값 어휘 — 이 여섯 타입만
 * "상태 개념이 있다"(has-status). epic의 내부 모델명은 Goal이나(pm.py:47 계층 리네이밍
 * B1) 참조 축 공개 타입명은 "epic"이다(reference_registry.ENTITY_RESOLVERS) — 그래서 여기
 * 키는 "epic"으로 둔다(story #2262 PO 판정 — "epic 카드 한 벌만 그린다"와 같은 이유). */
export type StatusBearingEntityType = 'story' | 'task' | 'doc' | 'hypothesis' | 'sprint' | 'epic';

const STATUS_BEARING_TYPES: ReadonlySet<string> = new Set<StatusBearingEntityType>([
  'story', 'task', 'doc', 'hypothesis', 'sprint', 'epic',
]);

/** ⛔맵에 없는 값이 오면(신규 status 추가 등) 칸을 비운다 — 원시값을 그대로 노출하지 않는다
 * (gate_type 사고 재발 방지, #2156 requires_human/gate_type 교훈 재사용). "terminal" 개념이
 * 이 제품에 없다는 판정(파울로, 2026-07-30)이 이미 서 있어 done류 라벨에 시각 차등(흐리게·
 * 취소선)을 안 준다 — 번역은 문구만 바꾸고 무게는 그대로다. */
const STATUS_LABELS: Record<StatusBearingEntityType, Record<string, string>> = {
  story: {
    done: '완료', backlog: '백로그', 'in-review': '검토 중', 'in-progress': '진행 중', 'ready-for-dev': '착수 대기',
  },
  task: { todo: '할 일', done: '완료', 'in-progress': '진행 중' },
  doc: { draft: '초안', confirmed: '확定', pending: '검토 대기' },
  hypothesis: {
    proposed: '제안됨', archived: '보관됨', active: '진행 중', measuring: '측정 중', falsified: '반증됨', verified: '검증됨',
  },
  sprint: { closed: '종료', active: '진행 중', planning: '계획 중' },
  epic: { archived: '보관됨', done: '완료', active: '진행 중' },
};

/** 「지금 상태」가 존재할 수 있는 타입인가(구조적 판정, AC2/AC7의 「아직 모름」↔「없음」을
 * 가르는 재료). `has-status`(status 개념이 있는 여섯 타입) 밖은 전부 `no-status-concept` —
 * artifact는 status 컬럼 자체가 없다(대신 `unresolved_comment_count`로 미결을 센다, PR②
 * v1이 짊어지지 않는 AC3의 재료). hypothesis·evidence는 오늘 fetch 경로 자체가 없다
 * (`ENTITY_API`에 의도적으로 빠져있음 — embed-card.tsx `ENTITY_API`/`EntityPreviewModal`
 * 주석 참고) — PR② v1은 이 둘을 배치조회 대상에서 뺀다(갭으로 문서화, 회귀 없음). asset은
 * FE 전용 타입이라 reference_registry 밖(원래 이 판정 대상이 아니다). */
export function entityStatusAvailability(entityType: string): 'has-status' | 'no-status-concept' {
  return STATUS_BEARING_TYPES.has(entityType) ? 'has-status' : 'no-status-concept';
}

/** rawStatus를 사람이 읽는 한 줄로 평평하게 바꾼다. has-status 타입이 아니거나, 매핑에 없는
 * 값이거나, rawStatus 자체가 없으면(아직 안 왔다) null — 호출부가 null을 "아직 모름"으로
 * 표시할지 "없음"으로 표시할지는 `entityStatusAvailability`로 미리 가른 뒤에 결정한다(이
 * 함수 혼자서는 그 둘을 구분할 재료가 없다 — status bearing 타입인데 rawStatus가 아직 없는
 * 것과, 애초에 status 개념이 없는 것은 다른 함수(entityStatusAvailability)가 가른다). */
export function translateEntityStatus(entityType: string, rawStatus: string | null | undefined): string | null {
  if (!rawStatus) return null;
  if (entityStatusAvailability(entityType) === 'no-status-concept') return null;
  const map = STATUS_LABELS[entityType as StatusBearingEntityType];
  return map[rawStatus] ?? null;
}
