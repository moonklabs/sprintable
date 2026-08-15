/**
 * story #2283 — 사람이 채팅에 평문으로 친 `#번호`·`#슬러그`를 「아직 참조가 안 된 후보」로
 * 잡는다. 순수 함수(부작용 없음) — 렌더 쪽(reference-suggestion-row.tsx)이 이걸 써서
 * "보낸 직후 그 메시지 바로 아래" 제안을 만든다.
 *
 * ⛔이미 토큰인 것은 후보에서 뺀다 — `[title](entity:type:id)` 토큰의 title 텍스트 안에
 * "#2249" 같은 글자가 우연히 들어 있어도(예: "Fix #2249 bug"라는 제목) 그건 이미 참조가
 * 선 것이므로 다시 묻지 않는다. 그래서 먼저 entity 토큰 구간을 걷어낸 텍스트에서만 찾는다.
 */

export type ReferenceCandidateKind = 'number' | 'slug';

export interface ReferenceCandidate {
  /** 매칭된 원문 그대로(예: "#2249", "#flow-map-blueprint-v1") — dedupe/거절 기억의 키. */
  raw: string;
  kind: ReferenceCandidateKind;
  /** '#' 뺀 값(예: "2249", "flow-map-blueprint-v1"). */
  value: string;
}

// story #2638 QA(2026-08-15) 파생 발견 — 정본 토큰(reference_token.py:_escape_title)은
// 제목의 \ [ ] ( ) 를 백슬래시로 이스케이프한다("[QA·폐기용] #2668 ..." 같은 실 제목이
// 전형). `[^\]]*`는 이스케이프된 `\]`의 `]`에서 멈춰(백슬래시를 못 봄) 이 토큰을 아예 못
// 지워, 제목 안의 "#2668" 같은 글자가 «이미 참조된 것»인데도 다시 「잇겠습니까?」 후보로
// 새는 걸 이 파일 자신의 docstring(⛔이미 토큰인 것은 후보에서 뺀다)이 막으려던 바로 그
// 케이스를 못 막았다. classifier.ts와 동형 수정(이스케이프 5종 전부 통과).
const ENTITY_TOKEN_RE = /\[(?:[^\]\\]|\\.)*\]\(entity:[a-z]+:[0-9a-fA-F-]+\)/g;
const NUMBER_RE = /#(\d{2,6})\b/g;
// 슬러그: 최소 한 번의 하이픈을 요구해 일반 해시태그성 단어와 구분한다(이 코드베이스의
// 실제 슬러그 관례 — 예: flow-map-blueprint-v1, provenance-attachment-point-inventory-...).
const SLUG_RE = /#([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/g;

export function findReferenceCandidates(content: string): ReferenceCandidate[] {
  if (!content) return [];
  const withoutTokens = content.replace(ENTITY_TOKEN_RE, (m) => ' '.repeat(m.length));

  const seen = new Set<string>();
  const result: ReferenceCandidate[] = [];

  for (const m of withoutTokens.matchAll(NUMBER_RE)) {
    const raw = m[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    result.push({ raw, kind: 'number', value: m[1]! });
  }
  for (const m of withoutTokens.matchAll(SLUG_RE)) {
    const raw = m[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    result.push({ raw, kind: 'slug', value: m[1]! });
  }
  return result;
}

// ── 거절 기억(AC3 ②, #2313 재확定) ───────────────────────────────────────────
// 네 축 전부 PO 판정(2026-07-29):
//   저장소=클라이언트 로컬(localStorage) — 잃어도 손해는 "한 번 더 묻는 것"뿐, 사고가
//     아니다(반대로 서버 저장은 오클릭 거절이 영영 남는 위험이 있다).
//   키    =원문 토큰 문자열 그대로(메시지 단위 아님) — #2049처럼 해소 안 되는 토큰도 키가 됨.
//   범위  =사용자 × 브라우저(로컬 저장이라 자동으로 그렇게 된다).
//   수명  =무기한(TTL 없음) — "며칠 뒤 다시 뜬다"는 사용자가 예측 못 하는 동작이라 금지.
// ⛔이전(#2283) 구현은 키가 `messageId::raw`라 같은 토큰도 다른 메시지에서 다시 물었다 —
// 그게 #2313의 재현 결함. 키에서 messageId를 뺐다(같은 토큰이면 어느 메시지에서 왔든 기억).
//
// ⛔다시 볼 조건(사람이 안 기억해도 사건으로 걸리는 것):
//   ①에이전트 경로에서도 이 제안이 나가게 될 때 — 에이전트에겐 브라우저(localStorage)가 없다.
//   ②사용자가 "또 떴다"를 실제로 불평할 때 — 그때가 서버 저장의 값이 증명되는 자리.
const REJECTED_KEY = 'sprintable:reference-candidates:rejected';
// 키 모양이 바뀌면(#2313 이전 messageId::raw 포함) 옛 값이 조용히 오매칭되지 않고 깨끗이
// 무시되도록 버전 프리픽스를 둔다.
const KEY_VERSION = 'v1';

function readRejectedSet(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(REJECTED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeRejectedSet(s: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(REJECTED_KEY, JSON.stringify(Array.from(s)));
  } catch {
    // localStorage 쓰기 실패(용량초과/프라이빗모드 등) — 조용히 무시, 다음 렌더에서 다시 물을 뿐.
  }
}

function rejectionKey(raw: string): string {
  return `${KEY_VERSION}:${raw}`;
}

export function isCandidateRejected(raw: string): boolean {
  return readRejectedSet().has(rejectionKey(raw));
}

export function rejectCandidate(raw: string): void {
  const s = readRejectedSet();
  s.add(rejectionKey(raw));
  writeRejectedSet(s);
}
