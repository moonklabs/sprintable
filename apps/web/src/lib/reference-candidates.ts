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

const ENTITY_TOKEN_RE = /\[[^\]]*\]\(entity:[a-z]+:[0-9a-fA-F-]+\)/g;
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

// ── 거절 기억(AC3 ②) ─────────────────────────────────────────────────────────
// ⛔이 세션이 짓는 만큼만 정직하게: BE에 거절 상태를 남길 표가 아직 없어(이 스토리의
// 쓰기 경로 자체가 미해결 — 착수 보고 참조) 브라우저 localStorage에만 남긴다. 즉 다른
// 기기·시크릿창·캐시삭제 후에는 다시 물을 수 있다 — durable하지 않다는 점을 명시한다.
// 거절 기억은 "소음 억제"이지 "데이터"가 아니라 잃어버려도 손해는 "한 번 더 묻는 것"뿐이라
// 지금은 이걸로 충분하다(PO 판정, 2026-07-28).
//
// ⛔이 선택이 부족해지는 조건(다음 사람이 "왜 localStorage지?"를 다시 판단하지 않도록 —
// 조건이 오면 서버 쪽(거절 기억 전용 표 또는 Reference 신설 시 그 옆)으로 옮긴다):
//   ①사람이 기기를 바꾸면 거절이 안 따라간다 — 같은 후보를 또 묻게 된다.
//   ②제안이 잦아지면(#2269가 본문에 쌓인 기존 참조를 캐기 시작하면) 체감이 커진다.
const REJECTED_KEY = 'sprintable:reference-candidates:rejected';

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

function rejectionKey(messageId: string, raw: string): string {
  return `${messageId}::${raw}`;
}

export function isCandidateRejected(messageId: string, raw: string): boolean {
  return readRejectedSet().has(rejectionKey(messageId, raw));
}

export function rejectCandidate(messageId: string, raw: string): void {
  const s = readRejectedSet();
  s.add(rejectionKey(messageId, raw));
  writeRejectedSet(s);
}
