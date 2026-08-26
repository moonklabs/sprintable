// @vitest-environment jsdom
//
// story #2535(E-FLOW-V4 S5) — S1에서 지구층 전용이던 ScaleLadder를 재사용 컴포넌트로 분리.
// activeLevel prop이 어느 rung을 강조하는지만 값으로 잰다(기본값=지구, S1 회귀 없음).
//
// story #3112(Board IA·D0(a), 선생님 승인 2026-08-26·카드 520beb8b) — «탭처럼 보이는데
// 클릭 안 됨»(선생님 재지적 2회) 정정. ScaleLadder가 컴포넌트 레벨에서 클릭을 스스로
// 배선한다(usePathname으로 ws/proj 세그먼트를 뽑아 렌즈 전환/이동 URL을 조립) — 두 호출부
// (flow-client.tsx·hypothesis-earth-layer.tsx)가 각자 배선할 필요가 없다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ScaleLadder } from './scale-ladder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let currentSearch = '';
const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => '/ws-1/proj-1/flow',
}));

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
  currentSearch = '';
  pushMock.mockClear();
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

  // story #3112 — 조건①(이동 칸만 ↗·나머지 렌즈 칸은 ↗ 無)·②(렌즈 세그 흡수, 클릭 배선)를
  // 값으로 잰다. 픽셀 규격: artifact c1f89cb5 v3.
  describe('클릭 배선(D0(a), story #3112)', () => {
    function findRung(name: string): HTMLElement | undefined {
      return Array.from(container.querySelector('.flex.overflow-hidden')?.children ?? []).find(
        (d) => d.textContent?.includes(name),
      ) as HTMLElement | undefined;
    }

    it('가설 rung은 버튼이고 클릭하면 view=hypothesis로 push한다', () => {
      act(() => { root.render(wrap(<ScaleLadder activeLevel="city" />)); });
      const rung = findRung(koMessages.flow.ladderName_earth);
      expect(rung?.tagName).toBe('BUTTON');
      act(() => { rung!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).toHaveBeenCalledWith('/ws-1/proj-1/flow?view=hypothesis');
    });

    it('갈래 rung은 버튼이고 클릭하면 view=flow로 push한다', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const rung = findRung(koMessages.flow.ladderName_city);
      expect(rung?.tagName).toBe('BUTTON');
      act(() => { rung!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).toHaveBeenCalledWith('/ws-1/proj-1/flow?view=flow');
    });

    it('스토리 rung은 버튼이고 클릭하면 view= 쿼리를 지운다(list=기본값)', () => {
      currentSearch = 'view=flow';
      act(() => { root.render(wrap(<ScaleLadder activeLevel="city" />)); });
      const rung = findRung(koMessages.flow.ladderName_street);
      act(() => { rung!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).toHaveBeenCalledWith('/ws-1/proj-1/flow');
    });

    it('렌즈 rung 클릭은 다른 기존 쿼리(story= 등)를 보존한다', () => {
      currentSearch = 'story=s-1';
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const rung = findRung(koMessages.flow.ladderName_city);
      act(() => { rung!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const pushedUrl = pushMock.mock.calls[0]?.[0] as string;
      expect(pushedUrl).toContain('story=s-1');
      expect(pushedUrl).toContain('view=flow');
    });

    it('목표 rung은 링크(a)이고 /goals로 이동한다 — 렌즈 전환이 아니라 인접 표면 이동(조건①)', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const rung = findRung(koMessages.flow.ladderName_continent);
      expect(rung?.tagName).toBe('A');
      expect(rung?.getAttribute('href')).toBe('/ws-1/proj-1/goals');
      expect(rung?.textContent).toContain('↗');
    });

    it('작업 rung은 클릭 요소가 아니다(button도 a도 아님) — 전용 표면 없음, 거짓 ↗ 금지(조건①)', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const rung = findRung(koMessages.flow.ladderName_building);
      expect(rung?.tagName).not.toBe('BUTTON');
      expect(rung?.tagName).not.toBe('A');
      expect(rung?.textContent).not.toContain('↗');
      act(() => { rung!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('렌즈/이동/대기 라벨로 이중 표식된다(조건① — 화살표만으론 부족, 텍스트 라벨도 동반)', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const earthRung = findRung(koMessages.flow.ladderName_earth);
      const goalRung = findRung(koMessages.flow.ladderName_continent);
      const taskRung = findRung(koMessages.flow.ladderName_building);
      expect(earthRung?.textContent).toContain(koMessages.flow.ladderLabelLens);
      expect(goalRung?.textContent).toContain(koMessages.flow.ladderLabelMove);
      expect(taskRung?.textContent).toContain(koMessages.flow.ladderLabelPending);
    });
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
      const chips = Array.from(container.querySelectorAll('button, a, span')).filter((s) =>
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

    // story #3112 — 모바일은 옛 3버튼 세그가 없어져 이 칩열이 유일한 렌즈 전환 경로다.
    it('compact 모드도 렌즈 rung 클릭이 동작한다(모바일 렌즈 전환 경로 유일)', () => {
      act(() => { root.render(wrap(<ScaleLadder compact />)); });
      const cityChip = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === koMessages.flow.ladderName_city,
      );
      expect(cityChip).toBeTruthy();
      act(() => { cityChip!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).toHaveBeenCalledWith('/ws-1/proj-1/flow?view=flow');
    });

    it('compact 모드도 목표 칩은 링크(a)로 /goals 이동한다', () => {
      act(() => { root.render(wrap(<ScaleLadder compact />)); });
      const goalChip = Array.from(container.querySelectorAll('a')).find(
        (a) => a.textContent === koMessages.flow.ladderName_continent,
      );
      expect(goalChip?.getAttribute('href')).toBe('/ws-1/proj-1/goals');
    });
  });
});
