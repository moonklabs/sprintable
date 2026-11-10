// @vitest-environment jsdom
//
// story #2535(E-FLOW-V4 S5) — S1에서 지구층 전용이던 ScaleLadder를 재사용 컴포넌트로 분리.
// activeLevel prop이 어느 rung을 강조하는지만 값으로 잰다(기본값=지구, S1 회귀 없음).
//
// story #4888(UI-5 보드 머리 첫 조각) — 카드열(이름+질문, 120.5px)을 없애고 칩 한 줄(모든 폭)만 남겼다. 질문은 칩 title로 옮겼다.
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


const CHIPS = '[data-testid="scale-ladder-chips"]';

function chips(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`${CHIPS} > *`));
}
function findChip(name: string): HTMLElement | undefined {
  return chips().find((d) => d.textContent?.includes(name));
}
const LEVELS = ['earth', 'continent', 'city', 'street', 'building'] as const;

describe('ScaleLadder — 칩 한 줄(story #4888)', () => {
  it('5단(가설·목표·갈래·스토리·작업)이 칩으로 전부 렌더된다 · 칩 5개', () => {
    act(() => { root.render(wrap(<ScaleLadder />)); });
    expect(chips()).toHaveLength(5);
    for (const l of LEVELS) expect(container.textContent).toContain(koMessages.flow[`ladderName_${l}` as const]);
  });

  // 되돌리면 RED: 카드열(질문 줄을 글자로 그리는 판)이 되살아나면 질문 문구가 본문에 나타난다.
  it('질문 문구는 본문 글자로 그리지 않는다 — 칩 title로만(카드열이 돌아오면 RED)', () => {
    act(() => { root.render(wrap(<ScaleLadder />)); });
    for (const l of LEVELS) {
      const q = koMessages.flow[`ladderQuestion_${l}` as const];
      expect(container.textContent).not.toContain(q);
      expect(chips().find((c) => c.getAttribute('title') === q || c.querySelector(`[title="${q}"]`)), `${l} title`).toBeTruthy();
    }
    expect(container.querySelector('.overflow-hidden.rounded-xl')).toBeNull();
  });

  it('legend 줄("지구"류 행성 이름표)은 렌더되지 않는다', () => {
    act(() => { root.render(wrap(<ScaleLadder />)); });
    expect(container.textContent).not.toContain('지구');
    expect(container.textContent).not.toContain('대륙');
  });

  it('activeLevel 기본값은 가설(지구) — 칩 하나만 강조된다', () => {
    act(() => { root.render(wrap(<ScaleLadder />)); });
    const on = chips().filter((c) => c.className.includes('text-brand-text'));
    expect(on).toHaveLength(1);
    expect(on[0]?.textContent).toContain(koMessages.flow.ladderName_earth);
    expect(on[0]?.getAttribute('aria-current')).toBe('true');
  });

  it('activeLevel="city"를 주면 갈래 칩만 강조되고 가설은 강조되지 않는다', () => {
    act(() => { root.render(wrap(<ScaleLadder activeLevel="city" />)); });
    expect(findChip(koMessages.flow.ladderName_city)?.className).toContain('text-brand-text');
    expect(findChip(koMessages.flow.ladderName_earth)?.className).not.toContain('text-brand-text');
    expect(chips().filter((c) => c.getAttribute('aria-current') === 'true')).toHaveLength(1);
  });

  // story #3112 — 조건①(이동 칸만 ↗·나머지 렌즈 칸은 ↗ 無)·②(렌즈 세그 흡수, 클릭 배선).
  describe('클릭 배선(D0(a), story #3112)', () => {
    it('가설 칩은 버튼이고 클릭하면 view=hypothesis로 push한다', () => {
      act(() => { root.render(wrap(<ScaleLadder activeLevel="city" />)); });
      const chip = findChip(koMessages.flow.ladderName_earth);
      expect(chip?.tagName).toBe('BUTTON');
      act(() => { chip!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).toHaveBeenCalledWith('/ws-1/proj-1/flow?view=hypothesis');
    });

    it('갈래 칩은 버튼이고 클릭하면 view=flow로 push한다', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const chip = findChip(koMessages.flow.ladderName_city);
      expect(chip?.tagName).toBe('BUTTON');
      act(() => { chip!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).toHaveBeenCalledWith('/ws-1/proj-1/flow?view=flow');
    });

    it('스토리 칩 클릭은 view 파라미터를 지운다(list=기본값)', () => {
      currentSearch = 'view=flow&story=s-1';
      act(() => { root.render(wrap(<ScaleLadder activeLevel="city" />)); });
      act(() => { findChip(koMessages.flow.ladderName_street)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).toHaveBeenCalledWith('/ws-1/proj-1/flow?story=s-1');
    });

    it('렌즈 칩 클릭은 다른 기존 쿼리(story= 등)를 보존한다', () => {
      currentSearch = 'story=s-1';
      act(() => { root.render(wrap(<ScaleLadder />)); });
      act(() => { findChip(koMessages.flow.ladderName_city)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const pushedUrl = pushMock.mock.calls[0]?.[0] as string;
      expect(pushedUrl).toContain('story=s-1');
      expect(pushedUrl).toContain('view=flow');
    });

    it('목표 칩은 링크(a)이고 /goals로 이동한다 — 렌즈 전환이 아니라 인접 표면 이동(조건①) · ↗는 이 칩에만', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const chip = findChip(koMessages.flow.ladderName_continent);
      expect(chip?.tagName).toBe('A');
      expect(chip?.getAttribute('href')).toBe('/ws-1/proj-1/goals');
      expect(chip?.textContent).toContain('↗');
      expect(chips().filter((c) => c.textContent?.includes('↗'))).toHaveLength(1);
    });

    it('작업 칩은 표면 이동 링크가 아니다 — 거짓 ↗ 금지(조건①) · 클릭해도 push 없음', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const chip = findChip(koMessages.flow.ladderName_building);
      expect(chip?.tagName).not.toBe('A');
      expect(chip?.textContent).not.toContain('↗');
      act(() => { chip!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).not.toHaveBeenCalled();
    });
  });

  // story #3130(유나 SSOT doc 4f6cba9b) — 「작업」 reserved(클릭 가능·안내 팝오버). 팝오버는 body로 포털(story #4349).
  describe('작업 칩 예약 신호(story #3130)', () => {
    const trigger = () => findChip(koMessages.flow.ladderName_building)!.querySelector('button')!;

    it('dead가 아니라 reserved다 — cursor-help, cursor-not-allowed·aria-disabled 없음', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      expect(trigger().className).toContain('cursor-help');
      expect(trigger().className).not.toContain('cursor-not-allowed');
      expect(trigger().getAttribute('aria-disabled')).toBeNull();
    });

    it('클릭하면 안내 팝오버가 뜬다 — push는 안 한다 · 문구에 «고장이 아니라»', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      expect(document.body.textContent).not.toContain(koMessages.flow.ladderReservedInfo);
      act(() => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(koMessages.flow.ladderReservedInfo);
      expect(koMessages.flow.ladderReservedInfo).toContain('고장이 아니라');
    });

    it('열렸을 때만 aria-describedby가 팝오버 id를 가리킨다', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      expect(trigger().getAttribute('aria-describedby')).toBeNull();
      act(() => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const describedBy = trigger().getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(document.body.querySelector(`#${describedBy}`)?.textContent).toBe(koMessages.flow.ladderReservedInfo);
    });

    it('다시 클릭하면(토글) 닫힌다', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      act(() => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      act(() => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(document.body.textContent).not.toContain(koMessages.flow.ladderReservedInfo);
    });

    it('바깥 클릭 · Escape로 닫힌다', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      act(() => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
      expect(document.body.textContent).not.toContain(koMessages.flow.ladderReservedInfo);
      act(() => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(document.body.textContent).not.toContain(koMessages.flow.ladderReservedInfo);
    });

    it('포털된 팝오버 안을 눌러도 닫히지 않는다 — 바깥 클릭 판정이 팝오버를 «안»으로 센다(story #4349)', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      act(() => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const pop = document.body.querySelector<HTMLElement>('[data-dropdown-panel="scale-ladder-info"]')!;
      act(() => { pop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
      expect(document.body.textContent).toContain(koMessages.flow.ladderReservedInfo);
    });

    // story #4342 — 좁은 화면 오른쪽 칸에서 뷰포트 밖으로 나가던 부류: 열릴 때 재서 안으로 민다(jsdom은 배치를 안 해서 사각형을 값으로 둔다).
    it('팝오버: 오른쪽으로 108px 넘치면 translateX(-108px) · 폭 상한(story #4342)', () => {
      const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const hit = (this.getAttribute('data-dropdown-panel') ?? '').startsWith('scale-ladder-info');
        const r = hit ? { left: 900, right: 1124, width: 224 } : { left: 0, right: 0, width: 0 };
        return { ...r, top: 0, bottom: 0, height: hit ? 80 : 0, x: r.left, y: 0, toJSON: () => r } as DOMRect;
      });
      try {
        act(() => { root.render(wrap(<ScaleLadder />)); });
        act(() => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        const pop = document.body.querySelector<HTMLElement>('[data-dropdown-panel="scale-ladder-info"]');
        expect(pop).not.toBeNull();
        expect(pop!.style.transform).toBe('translateX(-108px)');
        expect(pop!.className).toContain('max-w-[calc(100vw-1rem)]');
      } finally {
        spy.mockRestore();
      }
    });

    // story #4349 — 칩 줄(overflow-x-auto)이 팝오버를 통째로 잘랐다 → body 직속 · fixed · 트리거 바로 아래 8px. 되돌리면(absolute로 줄 안) RED.
    it('팝오버: 부모 overflow 밖(body 직속) · fixed · 트리거 아래 8px(story #4349)', () => {
      const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const isAnchor = !!this.querySelector?.(':scope > button[aria-describedby]');
        const isPop = (this.getAttribute('data-dropdown-panel') ?? '').startsWith('scale-ladder-info');
        const r = isAnchor ? { left: 300, right: 420, top: 90, bottom: 120, width: 120, height: 30 }
          : isPop ? { left: 312, right: 536, top: 128, bottom: 208, width: 224, height: 80 }
            : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
        return { ...r, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
      });
      try {
        act(() => { root.render(wrap(<ScaleLadder activeLevel="city" />)); });
        act(() => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        const pop = document.body.querySelector<HTMLElement>('[data-dropdown-panel="scale-ladder-info"]')!;
        expect(pop.parentElement).toBe(document.body);
        expect(container.contains(pop)).toBe(false);
        expect(pop.style.position).toBe('fixed');
        expect(pop.style.top).toBe('128px');
        expect(pop.style.left).toBe('300px');
        expect(pop.style.transform).toBe('');
        expect(pop.className).not.toMatch(/(^|\s)(absolute|top-full)(\s|$)/);
        expect(trigger().getAttribute('aria-describedby')).toBe(pop.id);
        act(() => { root.render(wrap(<ScaleLadder activeLevel="city" />)); });
        const again = document.body.querySelector<HTMLElement>('[data-dropdown-panel="scale-ladder-info"]')!;
        expect(again.parentElement).toBe(document.body);
        expect(container.contains(again)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
