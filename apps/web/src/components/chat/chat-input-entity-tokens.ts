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

// story d6f8e025 — Enter는 채팅에서 전송 키를 겸한다. "#3086"까지 타이핑하고 아직 스페이스를
// 안 친 채로(=피커가 열린 채로) 전송하려고 Enter를 누르면, 화살표로 후보를 능동 선택한 적이
// 없어도(entityIndex는 새 결과 도착 시 자동으로 0번을 가리킨다) 그 최상위 후보가 조용히
// 토큰으로 삽입돼버렸다(실사례: backlink 오염). hasNavigated(moveUp/moveDown을 최소 1회
// 거쳤는지)가 true일 때만 Enter/Tab이 수락한다.
//
// ⛔story #3162(채팅·치환 결함 조사, customer-zero 다수) — Tab은 애초에 "전송 키가 아니라
// 위험 없다"고 판단해 이 게이트 밖이었다(무조건 true). 그 판단이 틀렸다: Tab은 필드 이동
// 습관(다른 UI로 넘어가려고·코드에디터 습관)으로 «메시지를 보낼 의도 없이도» 흔히 눌리는
// 키다 — 화살표로 후보를 한 번도 안 훑은 채 Tab을 누르면 최상위 후보가 조용히 삽입되는
// 것은 Enter 쪽과 완전히 같은 실패 클래스다(실사고: hex 색상 코드 `#595959` 타이핑 중
// Tab 습관이 무관 스토리를 삽입). Enter와 동일하게 hasNavigated 게이트를 적용한다 —
// d6f8e025가 절반만 고쳤던 것을 완성.
export function shouldAcceptEntityPickerSelection(key: string, hasNavigated: boolean): boolean {
  if (key === 'Tab' || key === 'Enter') return hasNavigated;
  return false;
}

// story d6f8e025(유나 design 지적, PO 판정) — 위 shouldAcceptEntityPickerSelection이 Enter를
// hasNavigated 전엔 안 받아주는데, 화면이 0번 후보를 늘 하이라이트/aria-selected로 보여주면
// 어포던스가 실제 동작과 어긋난다("선택된 것처럼 보이는데 Enter는 다르게 동작"). 화살표로
// 능동 탐색하기 전엔 어떤 후보도 시각적으로 "선택됨"이 아니어야 한다.
export function shouldHighlightEntityCandidate(idx: number, entityIndex: number, hasNavigated: boolean): boolean {
  return hasNavigated && idx === entityIndex;
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
