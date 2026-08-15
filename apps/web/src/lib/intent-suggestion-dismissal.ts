/**
 * story #2638 — 제안 카드 거절 기억. reference-candidates.ts(#2283/#2313)의 localStorage
 * 거절 저장 패턴과 동형(무기한·클라 로컬·messageId 불포함 키는 아님 — 여긴 메시지당 카드라
 * messageId+kind가 자연 키): 저장소를 잃어도 손해는 "한 번 더 뜨는 것"뿐.
 */

const DISMISSED_KEY = 'sprintable:intent-suggestion:dismissed';
const KEY_VERSION = 'v1';

function dismissalKey(messageId: string, kind: string): string {
  return `${KEY_VERSION}:${messageId}:${kind}`;
}

function readDismissedSet(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeDismissedSet(s: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(s)));
  } catch {
    // 용량초과/프라이빗모드 — 조용히 무시, 다음 렌더에서 다시 물을 뿐.
  }
}

export function isSuggestionDismissed(messageId: string, kind: string): boolean {
  return readDismissedSet().has(dismissalKey(messageId, kind));
}

export function dismissSuggestion(messageId: string, kind: string): void {
  const s = readDismissedSet();
  s.add(dismissalKey(messageId, kind));
  writeDismissedSet(s);
}
