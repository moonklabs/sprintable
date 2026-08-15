/**
 * story #2638(P3=B1, human-event-definer-design-v1 B1) — 챗 메시지에 «상신/보고/배정» 같은
 * 의도 문구가 있는데 실제 기제(게이트 상신·상태 전이·배정)가 안 걸린 조합을 보수적 규칙으로
 * 잡는다. NLP 분류기 아님 — 문구 패턴+entity 참조+현재 상태 3박자가 전부 맞을 때만 후보를
 * 낸다(reference-candidates.ts의 #번호/#슬러그 감지와 동형 철학: 순수 함수, 부작용 없음).
 *
 * 활성화 근거(스토리 본문): 어휘·기제(B2/B3)가 이미 있어도 PO가 말로만 때운 재발이 2회 —
 * 수동 힌트(next_action_code)는 안 읽힌다. 이 파일은 그 자리에 능동 제안 카드를 놓는
 * 감지축이다. entity 토큰 파서는 chat-bubble.tsx:229의 정규식과 동일 계약(entity:type:id).
 */

export type IntentSuggestionKind = 'approval' | 'completion' | 'assignment';

export interface EntityRef {
  type: string;
  id: string;
}

// PO 라이브 판정 RED(2026-08-15) — 정본 토큰(reference_token.py:_escape_title)은 제목 안의
// `\` [ ] ( ) 다섯 글자를 전부 백슬래시로 이스케이프한다("[QA·폐기용] 제목" → "\[QA·폐기용\]
// 제목"). 첫 버전 `[^\]]*`는 이스케이프된 `\]`의 `]` 문자 자체에서 멈춰버려(백슬래시를 못 봄)
// 실 토큰(제목에 대괄호가 든 것 — QA 폐기용 문서류가 전형)에서 전부 매치 실패했다. chat-bubble.
// tsx의 렌더은 react-markdown 실 파서(CommonMark 이스케이프 규칙 완전 준수)라 칩은 멀쩡히
// 떴다 — 이 정규식만 그 규칙을 흉내 못 낸 것. `(?:[^\]\\]|\\.)*` — `]`도 `\`도 아닌 문자
// 또는 "백슬래시+아무 문자 1개" 반복으로 고쳐 이스케이프 5종을 전부 통과시킨다.
const ENTITY_TOKEN_RE = /\[(?:[^\]\\]|\\.)*\]\(entity:([a-z]+):([0-9a-fA-F-]{36})\)/g;

/** content에서 `[title](entity:type:id)` 토큰을 전부 뽑는다 — 제목의 `_escape_title`
 * 이스케이프(reference_token.py)를 그대로 통과시킨다. 순서 보존, 중복 제거 안 함(호출부가
 * type별로 filter). */
export function extractEntityRefs(content: string | null | undefined): EntityRef[] {
  if (!content) return [];
  const refs: EntityRef[] = [];
  for (const m of content.matchAll(ENTITY_TOKEN_RE)) {
    refs.push({ type: m[1]!.toLowerCase(), id: m[2]! });
  }
  return refs;
}

// 보수적 규칙 — 오탐이 카드 하나 더 뜨는 것뿐이라 재현 여지는 넓게, 그래도 일상 대화의
// 흔한 낱말과는 안 겹치게(예: "결재"만 있고 "요청/올려/해주세요" 류 요청형 없이 순수
// 명사만 있으면 과호출 소지 — 그래서 요청형 어미/조사 붙은 패턴 위주로 잡는다).
const APPROVAL_INTENT_RE = /(승인\s*(요청|주시면|해주세요|부탁)|결재\s*(요청|올려|부탁|해주세요)|상신\s*(합니다|했습니다|드립니다|할게요))/;
const COMPLETION_INTENT_RE = /(완료\s*(했습니다|보고|됐습니다)|다\s*(했습니다|끝났습니다)|끝났습니다|마쳤습니다)/;
const ASSIGNMENT_INTENT_RE = /(배정\s*(할게요|합니다|해주세요|부탁)|맡(아주세요|길게요|기겠습니다))/;

export function detectApprovalIntent(content: string | null | undefined): boolean {
  return !!content && APPROVAL_INTENT_RE.test(content);
}

export function detectCompletionIntent(content: string | null | undefined): boolean {
  return !!content && COMPLETION_INTENT_RE.test(content);
}

export function detectAssignmentIntent(content: string | null | undefined): boolean {
  return !!content && ASSIGNMENT_INTENT_RE.test(content);
}

/** entity refs 중 kind에 맞는 첫 것만 — 카드는 메시지당 최대 1건(동시에 여러 문서/스토리를
 * 언급해도 첫 매치로 좁힌다, 과잉 카드 방지 — PO 판정 axis와 동일한 "제안일 뿐" 절제). */
export function firstRefOfType(refs: EntityRef[], types: readonly string[]): EntityRef | null {
  return refs.find((r) => types.includes(r.type)) ?? null;
}
