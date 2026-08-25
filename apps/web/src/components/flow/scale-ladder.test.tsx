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

  // 유나 design 재규격(2026-08-09) — 행성-은유 legend 줄(지구/대륙/도시/거리/건물) 제거,
  // rung은 이름+질문 둘만.
  it('legend 줄("지구"류 행성 이름표)은 더 이상 렌더되지 않는다', () => {
    act(() => { root.render(wrap(<ScaleLadder />)); });
    expect(container.textContent).not.toContain('지구');
    expect(container.textContent).not.toContain('대륙');
  });

  it('activeLevel 기본값은 지구(S1 회귀 없음 — 이전엔 하드코딩이었다)', () => {
    act(() => { root.render(wrap(<ScaleLadder />)); });
    // 사다리는 5개 direct child rung — 텍스트 포함 검색은 바깥 flex 컨테이너까지 걸리므로
    // 자식 목록에서만 찾는다.
    const rungs = Array.from(container.querySelector('.flex.overflow-hidden')?.children ?? []);
    const earthRung = rungs.find((d) => d.textContent?.includes(koMessages.flow.ladderName_earth));
    expect(earthRung?.className).toContain('bg-gradient-to-b');
  });

  it('active 강조는 이름(ladderName) 텍스트 쪽에 걸린다(legend 줄 제거로 옮겨온 자리)', () => {
    act(() => { root.render(wrap(<ScaleLadder />)); });
    const nameEl = Array.from(container.querySelectorAll('div')).find(
      (d) => d.textContent === koMessages.flow.ladderName_earth,
    );
    expect(nameEl?.className).toContain('text-brand');
  });

  it('activeLevel="city"를 주면 도시 rung만 강조되고 지구는 강조되지 않는다', () => {
    act(() => { root.render(wrap(<ScaleLadder activeLevel="city" />)); });
    const rungs = Array.from(container.querySelector('.flex.overflow-hidden')?.children ?? []);
    const cityRung = rungs.find((d) => d.textContent?.includes(koMessages.flow.ladderName_city));
    const earthRung = rungs.find((d) => d.textContent?.includes(koMessages.flow.ladderName_earth));
    expect(cityRung?.className).toContain('bg-gradient-to-b');
    expect(earthRung?.className).not.toContain('bg-gradient-to-b');
  });

  // story #3043(PO+유나 IA 확定 ⓐ, 2026-08-25) — <lg에서 이 카드열(이름+질문 5칸)이 「주」처럼
  // 보여 보드(칸반) 콘텐츠를 아래로 밀어냈다(유나 실측). compact 모드는 이름만 남긴 칩열이다.
  describe('compact(ⓐ 렌즈/필터 축소)', () => {
    it('compact=true면 질문 문구(ladderQuestion_*)는 안 그린다 — 이름만 남는다', () => {
      act(() => { root.render(wrap(<ScaleLadder compact />)); });
      expect(container.textContent).toContain(koMessages.flow.ladderName_earth);
      expect(container.textContent).not.toContain(koMessages.flow.ladderQuestion_earth);
    });

    it('compact=true여도 activeLevel 강조는 유지된다(정보 손실 없음)', () => {
      act(() => { root.render(wrap(<ScaleLadder compact activeLevel="city" />)); });
      const chips = Array.from(container.querySelectorAll('span')).filter((s) =>
        Object.values(koMessages.flow).some((v) => v === s.textContent),
      );
      const cityChip = chips.find((s) => s.textContent === koMessages.flow.ladderName_city);
      const earthChip = chips.find((s) => s.textContent === koMessages.flow.ladderName_earth);
      expect(cityChip?.className).toContain('text-brand');
      expect(earthChip?.className).not.toContain('text-brand');
    });

    it('compact=false(기본값)는 기존 카드열 그대로다(회귀 없음)', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      expect(container.textContent).toContain(koMessages.flow.ladderQuestion_earth);
    });
  });
});
