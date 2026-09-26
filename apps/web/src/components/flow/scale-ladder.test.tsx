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

    it('작업 rung은 목표(A)처럼 표면 이동 링크가 아니다 — 거짓 ↗ 금지는 여전히 유효(조건①)', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const rung = findRung(koMessages.flow.ladderName_building);
      expect(rung?.tagName).not.toBe('A');
      expect(rung?.textContent).not.toContain('↗');
      act(() => { rung!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('렌즈/이동 라벨로 이중 표식된다(조건① — 화살표만으론 부족, 텍스트 라벨도 동반)', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const earthRung = findRung(koMessages.flow.ladderName_earth);
      const goalRung = findRung(koMessages.flow.ladderName_continent);
      expect(earthRung?.textContent).toContain(koMessages.flow.ladderLabelLens);
      expect(goalRung?.textContent).toContain(koMessages.flow.ladderLabelMove);
    });
  });

  // story #3130(유나 SSOT doc 4f6cba9b) — 「작업」 dead(클릭 불가·«고장»으로 읽힘) →
  // reserved(클릭 가능·안내 팝오버) 전환. 선생님이 "왜 안 눌리는지" 재차 물은 실목격 정정.
  describe('작업 rung 예약 신호(story #3130)', () => {
    // story #4349 — 안내 팝오버는 부모 overflow 밖 body로 포털된다 → 팝오버 글자 · 요소는 container가 아니라 document.body에서 찾는다(뜻은 그대로).
    function findRung(name: string): HTMLElement | undefined {
      return Array.from(container.querySelector('.flex.overflow-hidden')?.children ?? []).find(
        (d) => d.textContent?.includes(name),
      ) as HTMLElement | undefined;
    }

    it('«표면 대기» 대신 칩(«◇ 스토리 안에 있음»)이 렌더된다 — 옛 라벨은 잔존하지 않는다', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const taskRung = findRung(koMessages.flow.ladderName_building);
      expect(taskRung?.textContent).toContain(koMessages.flow.ladderReservedChip);
      expect(taskRung?.textContent).not.toContain(koMessages.flow.ladderLabelPending);
    });

    it('dead가 아니라 reserved다 — cursor-not-allowed가 아니라 cursor-help, aria-disabled 없음', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const taskRung = findRung(koMessages.flow.ladderName_building);
      expect(taskRung?.className).toContain('cursor-help');
      expect(taskRung?.className).not.toContain('cursor-not-allowed');
      expect(taskRung?.getAttribute('aria-disabled')).toBeNull();
    });

    it('클릭 가능한 button이 내부에 있다 — 클릭해도 push는 안 하지만(전용 표면 없음) 안내 팝오버가 뜬다', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const taskRung = findRung(koMessages.flow.ladderName_building);
      const trigger = taskRung?.querySelector('button');
      expect(trigger).toBeTruthy();
      expect(document.body.textContent).not.toContain(koMessages.flow.ladderReservedInfo);
      act(() => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(koMessages.flow.ladderReservedInfo);
      // doc(4f6cba9b) MUST — «고장이 아니라» 절이 문구에 verbatim으로 있어야 한다.
      expect(koMessages.flow.ladderReservedInfo).toContain('고장이 아니라');
    });

    it('열렸을 때만 aria-describedby가 팝오버 id를 가리킨다', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const taskRung = findRung(koMessages.flow.ladderName_building);
      const trigger = taskRung!.querySelector('button')!;
      expect(trigger.getAttribute('aria-describedby')).toBeNull();
      act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const describedBy = trigger.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const info = document.body.querySelector(`#${describedBy}`);
      expect(info?.textContent).toBe(koMessages.flow.ladderReservedInfo);
    });

    it('다시 클릭하면(토글) 팝오버가 닫힌다', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const trigger = findRung(koMessages.flow.ladderName_building)!.querySelector('button')!;
      act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(document.body.textContent).toContain(koMessages.flow.ladderReservedInfo);
      act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(document.body.textContent).not.toContain(koMessages.flow.ladderReservedInfo);
    });

    it('바깥을 클릭하면 팝오버가 닫힌다', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const trigger = findRung(koMessages.flow.ladderName_building)!.querySelector('button')!;
      act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(document.body.textContent).toContain(koMessages.flow.ladderReservedInfo);
      act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
      expect(document.body.textContent).not.toContain(koMessages.flow.ladderReservedInfo);
    });

    it('Escape 키로 팝오버가 닫힌다', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const trigger = findRung(koMessages.flow.ladderName_building)!.querySelector('button')!;
      act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(document.body.textContent).toContain(koMessages.flow.ladderReservedInfo);
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(document.body.textContent).not.toContain(koMessages.flow.ladderReservedInfo);
    });

    it('compact 모드도 작업 칩 클릭 시 같은 안내 팝오버가 뜬다(터치는 hover가 없어 유일한 안내 경로)', () => {
      act(() => { root.render(wrap(<ScaleLadder compact />)); });
      const trigger = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.includes(koMessages.flow.ladderName_building),
      );
      expect(trigger).toBeTruthy();
      act(() => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(document.body.textContent).toContain(koMessages.flow.ladderReservedInfo);
    });

    // story #4342 — 안내 팝오버(w-56 · 한쪽 맞춤)가 좁은 화면 오른쪽 칸에서 뷰포트 밖으로 나가던 부류. compact(:161) · 전체(:263) 두 갈래 다
    // 열릴 때 재서 안으로 민다. jsdom은 배치를 안 해서 팝오버 사각형을 값으로 둔다(오른쪽으로 108px 넘친 224px · 뷰포트 1024).
    it.each([
      ['전체', false, 'scale-ladder-info-full'],
      ['compact', true, 'scale-ladder-info'],
    ])('%s 갈래 팝오버: 열리면 오른쪽 넘침 → translateX(-108px) · 폭 상한 · 표지(story #4342)', (_label, compact, panel) => {
      const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const hit = (this.getAttribute('data-dropdown-panel') ?? '').startsWith('scale-ladder-info');
        const r = hit ? { left: 900, right: 1124, width: 224 } : { left: 0, right: 0, width: 0 };
        return { ...r, top: 0, bottom: 0, height: hit ? 80 : 0, x: r.left, y: 0, toJSON: () => r } as DOMRect;
      });
      try {
        act(() => { root.render(wrap(<ScaleLadder compact={compact} />)); });
        const trigger = compact
          ? Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.flow.ladderName_building))
          : findRung(koMessages.flow.ladderName_building)?.querySelector('button');
        act(() => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        const pop = document.body.querySelector<HTMLElement>(`[data-dropdown-panel="${panel}"]`);
        expect(pop, panel).not.toBeNull();
        expect(pop!.style.transform).toBe('translateX(-108px)');
        expect(pop!.className).toContain('max-w-[calc(100vw-1rem)]');
      } finally {
        spy.mockRestore();
      }
    });

    // story #4349(유나 실측) — 두 갈래 팝오버가 **어떤 폭에서도 안 보였다**: 담는 블록이 짧은 띠(compact 칩 줄 `overflow-x-auto` · 전체판 `overflow-hidden`) 안이라
    // 띠가 팝오버 90px를 통째로 잘랐다. 이제 body로 포털 → 부모 overflow 조상 0 · fixed · 트리거 사각형 바로 아래(전체판은 칸 왼쪽 + 12px).
    // 되돌리면(absolute로 띠 안) RED — body 직속 · overflow 조상 0 · fixed가 모두 깨진다.
    it.each([
      ['전체', false, 'scale-ladder-info-full', 312],
      ['compact', true, 'scale-ladder-info', 300],
    ])('%s 갈래 팝오버: 부모 overflow 밖(body 직속) · fixed · 트리거 아래 8px(story #4349)', (_label, compact, panel, wantLeft) => {
      const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        // 기준 트리거(열린 칸 wrapper) = 설명 연결된 버튼을 바로 품은 요소 · 팝오버는 뷰포트 안(밀지 않음).
        const isAnchor = !!this.querySelector?.(':scope > button[aria-describedby]');
        const isPop = (this.getAttribute('data-dropdown-panel') ?? '').startsWith('scale-ladder-info');
        const r = isAnchor ? { left: 300, right: 420, top: 90, bottom: 120, width: 120, height: 30 }
          : isPop ? { left: 312, right: 536, top: 128, bottom: 208, width: 224, height: 80 }
            : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
        return { ...r, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
      });
      try {
        act(() => { root.render(wrap(<ScaleLadder compact={compact} />)); });
        const trigger = compact
          ? Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.flow.ladderName_building))
          : findRung(koMessages.flow.ladderName_building)?.querySelector('button');
        act(() => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        const pop = document.body.querySelector<HTMLElement>(`[data-dropdown-panel="${panel}"]`)!;
        expect(pop, panel).not.toBeNull();
        expect(pop.parentElement).toBe(document.body);
        expect(container.contains(pop)).toBe(false);
        expect(pop.closest('[class*="overflow-"]')).toBeNull();
        expect(pop.style.position).toBe('fixed');
        expect(pop.style.visibility).toBe(''); // 붙는 순간 숨겼다가 둔 뒤 드러낸다 — 못 두면 숨은 채(= 옛 결함과 같은 «안 보임»)
        expect(pop.style.top).toBe('128px');
        expect(pop.style.left).toBe(`${wantLeft}px`);
        expect(pop.style.transform).toBe('');
        expect(pop.className).not.toMatch(/(^|\s)(absolute|top-full)(\s|$)/);
        // 트리거 버튼 aria-describedby가 포털된 팝오버를 가리킨다(id 연결은 DOM 위치와 무관).
        expect(trigger!.getAttribute('aria-describedby')).toBe(pop.id);
        // 열린 뒤 다시 그려져도(부모 props · 상태) body 직속 그대로 — 트리거 안으로 옮겨 가면 띠가 다시 자른다(뮤테이션 A1).
        act(() => { root.render(wrap(<ScaleLadder compact={compact} activeLevel="city" />)); });
        const again = document.body.querySelector<HTMLElement>(`[data-dropdown-panel="${panel}"]`)!;
        expect(again.parentElement).toBe(document.body);
        expect(container.contains(again)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('포털된 팝오버 안을 눌러도 닫히지 않는다 — 바깥 클릭 판정이 팝오버를 «안»으로 센다(story #4349)', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const trigger = findRung(koMessages.flow.ladderName_building)!.querySelector('button')!;
      act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const pop = document.body.querySelector<HTMLElement>('[data-dropdown-panel="scale-ladder-info-full"]')!;
      act(() => { pop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
      expect(document.body.textContent).toContain(koMessages.flow.ladderReservedInfo);
      act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
      expect(document.body.textContent).not.toContain(koMessages.flow.ladderReservedInfo);
    });

    // story #4349 AC2 — 1440 바닥 칩(«◇ 스토리 안에 있음»)이 `absolute bottom-2`라 질문 줄을 덮었다(칸 아래 여백 24px < 칩 약 28px).
    // 이제 흐름 안(버튼 flex-col · mt-auto · pt-2) + 칸 아래 여백 pb-2 — 겹칠 수 없는 구조. 실제 픽셀은 PR 본문 실브라우저 판 · 유나 실측.
    it('전체판 작업 칸 바닥 칩 = 흐름 안(absolute 0) · 질문 줄과 pt-2 · 칸 pb-2(story #4349 AC2)', () => {
      act(() => { root.render(wrap(<ScaleLadder />)); });
      const rung = findRung(koMessages.flow.ladderName_building)!;
      const chip = rung.querySelector<HTMLElement>('[data-ladder-reserved-chip]')!;
      expect(chip.textContent).toBe(koMessages.flow.ladderReservedChip);
      expect(chip.className.split(/\s+/)).toEqual(expect.arrayContaining(['mt-auto', 'pt-2']));
      for (const el of [chip, ...chip.querySelectorAll<HTMLElement>('*')]) expect(el.className).not.toMatch(/(^|\s)absolute(\s|$)/);
      expect(rung.querySelector('button')!.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'flex-col']));
      expect(rung.className.split(/\s+/)).toContain('pb-2');
      expect(rung.className.split(/\s+/)).not.toContain('pb-6');
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
