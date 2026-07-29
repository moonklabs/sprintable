/**
 * story #2264(C-6) — `#` 엔티티 토큰 조립의 참조 코어. chat-input.tsx(채팅)와
 * use-entity-picker.ts(다른 자리 — story 본문/AC 등) 둘 다 이 파일 하나를 쓴다.
 * AC3 판정: 새 자리를 열 때 이 파일의 diff가 0이어야 한다 — 여기 손대는 순간 "코어를
 * 고쳤다"는 뜻이라 이 스토리가 막으려는 바로 그 일이 된다.
 */

export interface EntityResult {
  entity_type: string;
  entity_id: string;
  title: string;
  status: string | null;
}

export function getEntityQuery(value: string, cursorPos: number): string | null {
  const before = value.slice(0, cursorPos);
  const m = before.match(/#([\w가-힣]*)$/);
  return m ? m[1]! : null;
}

// story #2292(보안·critical) — 링크 텍스트(markdown `[text](url)`의 text 부분) escape.
// `[ ] ( ) \` 와 개행이 markdown-link 토큰 구조를 변조(예 `x](https://phish)[y` → 외부
// phishing 링크 렌더)하는 걸 차단한다. ⛔형제 함수(applyEntity·applyAsset)가 이 상수 하나를
// 공유해야 한다 — 각자 자기 정규식을 들고 있으면 그게 바로 형제 비대칭이다.
export function escapeMarkdownLinkText(text: string): string {
  return text.replace(/[\\[\]()]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

export function applyEntity(
  value: string,
  cursorPos: number,
  title: string,
  entityType: string,
  entityId: string,
): { text: string; caretPos: number } {
  const before = value.slice(0, cursorPos);
  const m = before.match(/#([\w가-힣]*)$/);
  if (!m) return { text: value, caretPos: cursorPos };
  const start = cursorPos - m[0].length;
  // story #2292: title은 story/doc/epic/task 검색결과 — 자유 텍스트라 escape 필수(형제
  // applyAsset은 이미 하고 있었다. 여기만 빠져 있던 것이 발견된 결함).
  const safeTitle = escapeMarkdownLinkText(title);
  const replacement = `[${safeTitle}](entity:${entityType}:${entityId}) `;
  return { text: value.slice(0, start) + replacement + value.slice(cursorPos), caretPos: start + replacement.length };
}

// story #2263(C-5) ㉠㉢: 종류를 «글자»로 보이는 라벨. ⛔서버가 신규 종류를 주면(registry는
// 화면이 모르는 채로 늘 수 있다) 목록에 없는 값도 "정상 경로"로 그려야 한다 — 매핑이 없으면
// 원문 종류 문자열을 그대로 쓴다(공백/대문자 처리 없이도 "sprint"·"hypothesis"처럼 읽을 수
// 있는 값이라 그 자체로 충분히 "정상"이다. 빈 문자열·물음표·아이콘만 남기는 실패 대신).
const ENTITY_TYPE_LABELS: Record<string, string> = {
  story: '스토리', doc: '문서', epic: '에픽', task: '작업',
};
export function entityTypeLabel(type: string): string {
  return ENTITY_TYPE_LABELS[type] ?? type;
}

// story #2263(C-5) ㉡: 종류로 묶어 보이되 열은 나누지 않는다(키보드 이동이 한 줄기여야 하므로
// entityResults 자체의 순서를 그룹 순서로 재배열한다 — entityIndex가 이 배열을 그대로
// 인덱싱하므로 렌더 순서=키보드 이동 순서가 항상 같다, 별도 변환이 렌더 시점에 필요 없다).
// ⛔BE(entities.py)의 최종 정렬(가나다/최신순)이 종류를 뒤섞을 수 있으므로 첫 등장 순서를
// 그룹 우선순위로 쓰는 stable regroup(하드코딩된 타입 나열 없음 — 데이터가 순서를 정한다).
export function groupEntitiesByType(results: EntityResult[]): EntityResult[] {
  const order: string[] = [];
  const buckets = new Map<string, EntityResult[]>();
  for (const r of results) {
    if (!buckets.has(r.entity_type)) { buckets.set(r.entity_type, []); order.push(r.entity_type); }
    buckets.get(r.entity_type)!.push(r);
  }
  return order.flatMap((type) => buckets.get(type)!);
}
