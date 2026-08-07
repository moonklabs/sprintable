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

/** ⛔이 배치조회 가능 여부(PR② v1 스코프)와 「AC2가 정의한 status 어휘가 있는 타입」은
 * 다른 축이다 — hypothesis·sprint는 어휘는 있지만(STATUS_LABELS에 있음, 미래의 실 데이터
 * 소비를 위해 유지) 오늘 FE엔 fetch 경로 자체가 없어 PR② v1이 배치조회 대상에서 뺀다.
 * hypothesis는 ENTITY_API에 의도적으로 없고(embed-card.tsx 주석), sprint는 **단건조차**
 * 없다(ENTITY_API에 키 자체가 없음 — grep 재확認, BE #2905도 epic·task·doc·artifact
 * 넷만 배치 endpoint를 냈지 sprint는 범위 밖이었다). `entityStatusAvailability`(칩 렌더
 * 판정)는 이 「지금 채울 수 있는가」 축을 써야 한다 — 안 그러면 그 타입 칩이 영원히 안
 * 채워질 "아직 모름"에 갇힌다(실제로는 "이 판에선 원래 없음"이 맞는 그림이다). */
const PR2_V1_FETCHABLE_TYPES: ReadonlySet<string> = new Set(['story', 'task', 'doc', 'epic']);

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

/** 「지금 상태」를 **PR② v1이 실제로 채울 수 있는** 타입인가(구조적 판정, AC2/AC7의
 * 「아직 모름」↔「없음」을 가르는 재료 — 칩 렌더링이 이 함수로 판정한다). ⛔"AC2가 정의한
 * status 어휘가 있나"와는 다른 축이다(STATUS_LABELS 주석 참고) — hypothesis는 어휘는
 * 있어도 fetch 경로가 없어 여기선 no-status-concept다. artifact는 status 컬럼 자체가
 * 없다(대신 unresolved_comment_count로 미결을 센다, PR②가 짊어지지 않는 AC3의 재료).
 * evidence·asset도 마찬가지로 no-status-concept. */
export function entityStatusAvailability(entityType: string): 'has-status' | 'no-status-concept' {
  return PR2_V1_FETCHABLE_TYPES.has(entityType) ? 'has-status' : 'no-status-concept';
}

/** rawStatus를 사람이 읽는 한 줄로 평평하게 바꾼다. STATUS_LABELS에 그 타입 맵 자체가
 * 없거나, 매핑에 없는 값이거나, rawStatus 자체가 없으면(아직 안 왔다) null — ⛔이 함수는
 * `entityStatusAvailability`(PR② v1 fetch 가능 여부)와 별도다: hypothesis처럼 오늘 fetch
 * 경로는 없어도 어휘 맵은 있는 타입에 실제 rawStatus가 (미래에 다른 경로로) 들어오면 이
 * 함수는 정상 번역한다 — 「지금 채울 수 있나」는 칩 렌더 쪽(entityStatusAvailability) 책임,
 * 「번역할 수 있나」는 이 함수 책임으로 나눈다. */
export function translateEntityStatus(entityType: string, rawStatus: string | null | undefined): string | null {
  if (!rawStatus) return null;
  const map = STATUS_LABELS[entityType as StatusBearingEntityType];
  if (!map) return null;
  return map[rawStatus] ?? null;
}

/** story #2262 PR② — `EntityChip`이 받을 「칩 자체 상태」 prop의 예정 계약. 배치조회
 * 배선(chat-view.tsx, BE `?ids=` — 디디군 대기)만 아직 안 됐다 — 카피는 유나양 판정
 * 완료(2026-08-07)로 아래 세 상수에 이미 반영. `EntityChip`은 아직 이 prop을 안 받는다
 * (BE 오면 그때 prop 추가+`renderEntityStatusLabel` 호출을 한 번에 배선).
 *
 * `undefined`(prop 자체를 안 넘김) = 이 호출부에서 칩 상태 기능이 아직 안 켜짐(오늘의
 * 기본, 회귀 없음). 값이 오면:
 *   `{ kind: 'loading' }`        — 배치fetch 진행 중(has-status 타입에서만 의미 있음)
 *   `{ kind: 'resolved', raw }`  — 배치fetch 완료, raw를 `translateEntityStatus`로 번역해 쓴다
 *   `{ kind: 'error' }`          — 배치fetch 실패(네트워크 등) — "아직 모름"과 같은 급으로 다룬다
 * no-status-concept 타입(entityStatusAvailability로 미리 가른다)엔 이 prop 자체를 안 넘기는
 * 것을 호출부 관례로 삼는다(구조적으로 없는 것과 "아직 못 잰 것"을 prop 유무로도 가른다). */
export type EntityStatusFetchState =
  | { kind: 'loading' }
  | { kind: 'resolved'; raw: string | null }
  | { kind: 'error' };

/** 유나양 카피 판정(2026-08-07, #2262 AC2):
 * ① 상태 개념 자체가 없는 타입(hypothesis·evidence·artifact) → "상태 없음"
 *    (「없음」과 「아직 모름」이 나란히 렌더될 때 시각적으로 안 갈리면 "해당 없음"으로 대체
 *    검토 — 라이브 배선 後 유나 재확認 필요, 아직 미확定).
 * ② 배치조회 미완(loading) **또는 실패(error)** → "아직 모름" — ⛔"확認 중"은 쓰지 않는다
 *    (fetch가 실패한 순간엔 "확認 중"이 거짓이 된다 — 미완이든 실패든 "지금 모름"인 것은
 *    같은 사실이라 문구를 하나로 통일한다).
 * ③ has-status 타입인데 rawStatus가 매핑에 없음(신규 status 미반영 등) → 빈칸(문구 없음,
 *    `translateEntityStatus`가 이미 null을 낸다 — 새 문구를 안 만든다). */
export const ENTITY_STATUS_NO_CONCEPT_LABEL = '상태 없음';
export const ENTITY_STATUS_UNKNOWN_LABEL = '아직 모름';

/** `EntityStatusFetchState`(배치조회 결과)를 칩에 그대로 쓸 한 줄로 접는다. 반환 null은
 * "이 칩엔 상태 관련 문구를 아예 안 그린다"는 뜻(③ 매핑 안 된 값 — 빈칸도 「아직 모름」과는
 * 다르다, 매핑 자체가 없는 것은 새 status 추가를 놓친 FE 버그 신호이지 사용자에게 알릴
 * 정보가 아니다). state가 `undefined`(호출부가 기능 자체를 안 켬)면 이 함수를 안 부르는
 * 것이 호출부 관례 — 이 함수는 state가 실제로 있을 때만 호출된다는 전제다. */
export function renderEntityStatusLabel(entityType: string, state: EntityStatusFetchState): string | null {
  if (entityStatusAvailability(entityType) === 'no-status-concept') return ENTITY_STATUS_NO_CONCEPT_LABEL;
  if (state.kind === 'loading' || state.kind === 'error') return ENTITY_STATUS_UNKNOWN_LABEL;
  return translateEntityStatus(entityType, state.raw);
}

/** story #2262 PR② — chat-view.tsx의 배치조회가 타입별로 부를 `?ids=` 엔드포인트.
 * PR2_V1_FETCHABLE_TYPES와 정확히 같은 네 타입만 키를 가진다(그 밖 타입은 애초에 이
 * 맵을 조회할 일이 없다 — entityStatusAvailability가 먼저 걸러준다). */
export type BatchFetchableEntityType = 'story' | 'task' | 'doc' | 'epic';
export const ENTITY_STATUS_BATCH_API_PATH: Record<BatchFetchableEntityType, string> = {
  story: '/api/stories',
  task: '/api/tasks',
  doc: '/api/docs',
  epic: '/api/goals',
};

/** story #2262 PR② — chat-view.tsx의 배치조회 effect가 매 렌더 훑는 「메시지 목록 →
 * 타입별 아직 안 부른 id 묶음」 순수 로직만 분리했다(fetch·setState 없음 — React/SSE/네트워크
 * 전부 안 건드리는 순수함수라 chat-view.tsx 전체를 마운트하지 않고도 유닛테스트 가능,
 * flow-relation-review.ts와 같은 이유의 같은 패턴). `alreadyRequestedKeys`는 호출부가
 * 관리하는 ref의 Set — 이 함수는 그 Set을 직접 변형(mutate)해 다음 호출에서 중복을
 * 막는다(호출부가 매번 새 Set을 만들 필요 없게). */
export function groupUnresolvedReferencesByType(
  messages: Array<{ references?: Array<{ target_type: string; target_id: string }> }>,
  alreadyRequestedKeys: Set<string>,
): Map<BatchFetchableEntityType, string[]> {
  const idsByType = new Map<BatchFetchableEntityType, string[]>();
  for (const msg of messages) {
    for (const ref of msg.references ?? []) {
      if (entityStatusAvailability(ref.target_type) !== 'has-status') continue;
      const type = ref.target_type as BatchFetchableEntityType;
      const key = `${type}:${ref.target_id}`.toLowerCase();
      if (alreadyRequestedKeys.has(key)) continue;
      alreadyRequestedKeys.add(key);
      const list = idsByType.get(type) ?? [];
      list.push(ref.target_id);
      idsByType.set(type, list);
    }
  }
  return idsByType;
}
