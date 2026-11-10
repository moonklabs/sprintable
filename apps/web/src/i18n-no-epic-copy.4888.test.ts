// story 4888 (UI-5 P1) — «목표»와 «에픽»은 같은 것이다(서버는 같은 router를 /api/v2/goals · /api/v2/epics로 이중 서빙 — 계층 리네이밍 story 1925).
// 1925 이름 바꾸기가 프런트에서 덜 끝나 사람에게 두 이름이 같이 보였다(일감 탭 «에픽» ↔ 더보기 «목표» 등 ko 9 · en 9곳). 사람에게 보이는 글은 «목표» 하나.
// 이 가드는 ko · en 메시지의 «값»(키 이름 · API 경로 · 엔티티 타입 값이 아님)에 에픽/Epic이 다시 들어오면 RED. 되돌리면(값을 에픽으로) 실패한다.
import { describe, expect, it } from 'vitest';
import koMessages from '../messages/ko.json';
import enMessages from '../messages/en.json';

function stringValues(node: unknown, path: string[], out: Array<{ path: string; value: string }>): void {
  if (typeof node === 'string') out.push({ path: path.join('.'), value: node });
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) stringValues(v, [...path, k], out);
}

const all = (m: unknown) => { const out: Array<{ path: string; value: string }> = []; stringValues(m, [], out); return out; };

describe('story 4888 — 사람에게 보이는 이름은 «목표» 하나(에픽/Epic 0)', () => {
  it('ko 메시지 값에 «에픽»이 없다', () => {
    expect(all(koMessages).filter((e) => /에픽/.test(e.value))).toEqual([]);
  });

  it('en 메시지 값에 «epic(s)» 단어가 없다', () => {
    expect(all(enMessages).filter((e) => /\bepics?\b/i.test(e.value))).toEqual([]);
  });

  it('일감 탭 «epics» 라벨(nav.epic)은 ko «목표» · en «Goal»', () => {
    const ko = koMessages as unknown as { nav: Record<string, string> };
    const en = enMessages as unknown as { nav: Record<string, string> };
    expect(ko.nav.epic).toBe('목표');
    expect(en.nav.epic).toBe('Goal');
  });
});
