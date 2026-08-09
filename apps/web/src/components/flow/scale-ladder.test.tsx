// @vitest-environment jsdom
//
// story #2535(E-FLOW-V4 S5) — S1에서 지구층 전용이던 ScaleLadder를 재사용 컴포넌트로 분리.
// activeLevel prop이 어느 rung을 강조하는지만 값으로 잰다(기본값=지구, S1 회귀 없음).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ScaleLadder } from './scale-ladder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('ScaleLadder', () => {
  it('5단(지구·대륙·도시·거리·건물)이 전부 렌더된다', () => {
    act(() => { root.render(wrap(<ScaleLadder />)); });
    expect(container.textContent).toContain(koMessages.flow.ladderName_earth);
    expect(container.textContent).toContain(koMessages.flow.ladderName_continent);
    expect(container.textContent).toContain(koMessages.flow.ladderName_city);
    expect(container.textContent).toContain(koMessages.flow.ladderName_street);
    expect(container.textContent).toContain(koMessages.flow.ladderName_building);
  });

  it('activeLevel 기본값은 지구(S1 회귀 없음 — 이전엔 하드코딩이었다)', () => {
    act(() => { root.render(wrap(<ScaleLadder />)); });
    // 사다리는 5개 direct child rung — 텍스트 포함 검색은 바깥 flex 컨테이너까지 걸리므로
    // 자식 목록에서만 찾는다.
    const rungs = Array.from(container.querySelector('.flex.overflow-hidden')?.children ?? []);
    const earthRung = rungs.find((d) => d.textContent?.includes(koMessages.flow.ladderName_earth));
    expect(earthRung?.className).toContain('bg-gradient-to-b');
  });

  it('activeLevel="city"를 주면 도시 rung만 강조되고 지구는 강조되지 않는다', () => {
    act(() => { root.render(wrap(<ScaleLadder activeLevel="city" />)); });
    const rungs = Array.from(container.querySelector('.flex.overflow-hidden')?.children ?? []);
    const cityRung = rungs.find((d) => d.textContent?.includes(koMessages.flow.ladderName_city));
    const earthRung = rungs.find((d) => d.textContent?.includes(koMessages.flow.ladderName_earth));
    expect(cityRung?.className).toContain('bg-gradient-to-b');
    expect(earthRung?.className).not.toContain('bg-gradient-to-b');
  });
});
