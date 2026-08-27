/**
 * story d6f8e025 — Enter는 채팅 전송 키를 겸한다. "#3086"까지 타이핑하고 화살표로 후보를
 * 능동 선택한 적 없이(entityIndex는 새 결과 도착 시 자동으로 0번을 가리킨다) Enter를
 * 눌러 전송하려던 것이 조용히 최상위 후보를 토큰으로 삽입해버린 실사례(backlink 오염)를
 * 재발 안 되게 고정한다.
 *
 * story #3162(채팅·치환 결함 조사, customer-zero 다수) — d6f8e025는 Enter만 고쳤다(Tab은
 * "전송 키가 아니라 위험 없다"고 판단해 게이트 밖). 그 판단이 틀렸다는 게 실사고로
 * 드러났다(hex 색상 코드 `#595959` 타이핑 중 습관적 Tab이 무관 스토리를 삽입) — Tab에도
 * 같은 hasNavigated 게이트를 적용해 d6f8e025를 완성한다.
 */
import { describe, expect, it } from 'vitest';
import { shouldAcceptEntityPickerSelection, shouldHighlightEntityCandidate } from './chat-input-entity-tokens';

describe('shouldAcceptEntityPickerSelection', () => {
  it('능동 탐색(화살표) 없이 Enter — 수락하지 않는다(전송 의도로 취급)', () => {
    expect(shouldAcceptEntityPickerSelection('Enter', false)).toBe(false);
  });

  it('화살표로 최소 1회 탐색한 뒤 Enter — 수락한다(참조 의도로 취급)', () => {
    expect(shouldAcceptEntityPickerSelection('Enter', true)).toBe(true);
  });

  it('story #3162 — 능동 탐색 없이 Tab도 수락하지 않는다(습관적 Tab이 참조를 조용히 삽입하던 실사고 재발 방지)', () => {
    expect(shouldAcceptEntityPickerSelection('Tab', false)).toBe(false);
  });

  it('화살표로 최소 1회 탐색한 뒤 Tab — 수락한다(Enter와 동형)', () => {
    expect(shouldAcceptEntityPickerSelection('Tab', true)).toBe(true);
  });

  it('그 외 키는 수락하지 않는다', () => {
    expect(shouldAcceptEntityPickerSelection('Escape', true)).toBe(false);
    expect(shouldAcceptEntityPickerSelection('a', true)).toBe(false);
  });
});

// story d6f8e025(유나 design 지적, PO 판정) — 어포던스(화면 하이라이트/aria-selected)가
// shouldAcceptEntityPickerSelection의 실제 동작(Enter 미탐색 시 미수락)과 어긋나면 안 된다.
describe('shouldHighlightEntityCandidate', () => {
  it('능동 탐색 전엔 0번 후보도 하이라이트/aria-selected 되지 않는다', () => {
    expect(shouldHighlightEntityCandidate(0, 0, false)).toBe(false);
  });

  it('화살표로 탐색한 뒤엔 현재 entityIndex 위치만 하이라이트된다', () => {
    expect(shouldHighlightEntityCandidate(0, 0, true)).toBe(true);
    expect(shouldHighlightEntityCandidate(1, 0, true)).toBe(false);
  });
});
