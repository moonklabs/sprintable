// @vitest-environment jsdom
//
// story #4349 — AnchoredPopover: 트리거에 붙는 팝오버를 부모 overflow 밖(body)에 fixed로 그린다.
// jsdom은 배치를 안 해서 트리거 · 팝오버 사각형을 값으로 둔다(뷰포트 1024).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnchoredPopover, isOutsidePress, placeVertical, usePortalMenuKeys } from './anchored-popover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let anchorRect = { left: 100, right: 180, top: 40, bottom: 60 };
let popRect = { left: 100, right: 324 }; // 224px

beforeEach(() => {
  anchorRect = { left: 100, right: 180, top: 40, bottom: 60 };
  popRect = { left: 100, right: 324 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r = this.id === 'anchor' ? { ...anchorRect, width: anchorRect.right - anchorRect.left, height: 20 }
      : this.id === 'pop' ? { ...popRect, top: 0, bottom: 80, width: popRect.right - popRect.left, height: 80 }
        : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
  });
  container = document.createElement('div');
  container.className = 'overflow-hidden';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

// 트리거 wrapper의 ref가 **열릴 때만** 붙는 호출부 모양(축척 사다리와 같음) — 자식 ref가 먼저 붙는 순서를 그대로 재현한다.
function Harness({ offsetX, initiallyOpen = false, align }: { offsetX?: number; initiallyOpen?: boolean; tick?: number; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(initiallyOpen);
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div className="flex overflow-x-auto">
      <div id="anchor" ref={open ? anchorRef : undefined} className="relative">
        <button type="button" id="trigger" onClick={() => setOpen((v) => !v)}>열기</button>
        {open && <AnchoredPopover anchorRef={anchorRef} offsetX={offsetX} align={align} id="pop" role="tooltip" className="w-56">안내</AnchoredPopover>}
      </div>
    </div>
  );
}

const pop = () => document.getElementById('pop')!;

describe('AnchoredPopover(story #4349)', () => {
  it('body 직속 · fixed · 트리거 아래 8px · 트리거 왼쪽 + offsetX · 드러남(visibility)', () => {
    act(() => { root.render(<Harness offsetX={12} />); });
    act(() => { document.getElementById('trigger')!.click(); });
    expect(pop().parentElement).toBe(document.body);
    expect(container.contains(pop())).toBe(false);
    expect(pop().style.position).toBe('fixed');
    expect(pop().style.top).toBe('68px');
    expect(pop().style.left).toBe('112px');
    expect(pop().style.visibility).toBe('');
  });

  it('뷰포트 오른쪽으로 넘치면 여백 8px까지 translateX로 민다(4342 viewportShiftX)', () => {
    popRect = { left: 900, right: 1124 };
    act(() => { root.render(<Harness />); });
    act(() => { document.getElementById('trigger')!.click(); });
    expect(pop().style.transform).toBe('translateX(-108px)');
  });

  it('어느 조상이든 스크롤되면(capture) · 창 크기가 바뀌면 트리거 새 자리로 다시 둔다', () => {
    act(() => { root.render(<Harness />); });
    act(() => { document.getElementById('trigger')!.click(); });
    anchorRect = { left: 40, right: 120, top: 40, bottom: 60 }; // 칩 줄 가로 스크롤로 트리거가 왼쪽으로
    act(() => { container.firstElementChild!.dispatchEvent(new Event('scroll')); });
    expect(pop().style.left).toBe('40px');
    anchorRect = { left: 10, right: 90, top: 140, bottom: 160 };
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(pop().style.left).toBe('10px');
    expect(pop().style.top).toBe('168px');
  });

  it('닫히면 body에서 사라지고 듣기를 푼다', () => {
    act(() => { root.render(<Harness />); });
    act(() => { document.getElementById('trigger')!.click(); });
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    act(() => { document.getElementById('trigger')!.click(); });
    expect(document.getElementById('pop')).toBeNull();
    expect(removeSpy.mock.calls.some(([type, , capture]) => type === 'scroll' && capture === true)).toBe(true);
  });

  // 뮤테이션 A1(포털 대상을 «트리거 ?? body»로)이 첫 판에서 살아남았다 — 첫 렌더엔 트리거 ref가 아직 없어 body로 떨어지기 때문.
  // 열린 뒤 **다시 그려도**(부모 상태 · props 바뀜) 늘 body 직속이어야 한다(그때 트리거 안으로 옮겨 가면 부모 띠가 다시 자른다).
  it('열린 뒤 다시 그려져도 늘 body 직속(부모 안으로 옮겨 가지 않음)', () => {
    act(() => { root.render(<Harness />); });
    act(() => { document.getElementById('trigger')!.click(); });
    act(() => { root.render(<Harness tick={1} />); });
    act(() => { root.render(<Harness tick={2} />); });
    expect(pop().parentElement).toBe(document.body);
    expect(container.contains(pop())).toBe(false);
  });

  it('처음부터 열린 채 붙어도(트리거 ref가 자식보다 늦게 붙는 순서) 제자리에 드러난다', () => {
    act(() => { root.render(<Harness initiallyOpen />); });
    expect(pop().style.visibility).toBe('');
    expect(pop().style.top).toBe('68px');
  });

  // story #4349 AC5(유나 실측) — 모바일 서랍 문서 트리 행 메뉴가 목록 아래 끝에서 세로로 잘렸다: 아래가 모자라면 위로 뒤집는다.
  it('아래가 모자라고 위가 넓으면 위로 뒤집는다(트리거 위 8px · data-side=top) · 넉넉하면 아래(data-side=bottom)', () => {
    act(() => { root.render(<Harness />); });
    act(() => { document.getElementById('trigger')!.click(); });
    expect(pop().dataset.side).toBe('bottom');
    anchorRect = { left: 100, right: 180, top: 700, bottom: 720 }; // 뷰포트 768 · 팝오버 80 → 아래 32 · 위 684
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(pop().style.top).toBe('612px');
    expect(pop().dataset.side).toBe('top');
  });

  it('align="end" — 팝오버 오른쪽 끝을 트리거 오른쪽 끝에(예전 right-0)', () => {
    act(() => { root.render(<Harness align="end" />); });
    act(() => { document.getElementById('trigger')!.click(); });
    expect(pop().style.left).toBe('-44px'); // 180 − 224
  });
});

describe('placeVertical — 세로 자리(뷰포트 768 · 여백 8)', () => {
  it('아래에 다 들어가면 아래', () => {
    expect(placeVertical({ top: 40, bottom: 60 }, 80, 768, 4)).toEqual({ top: 64, side: 'bottom' });
  });
  it('아래가 모자라고 위가 넓으면 위(트리거 위 틈)', () => {
    expect(placeVertical({ top: 700, bottom: 720 }, 82, 768, 4)).toEqual({ top: 614, side: 'top' });
  });
  it('딱 맞으면 아래(경계: 아래 남는 칸 = 높이)', () => {
    expect(placeVertical({ top: 600, bottom: 676 }, 80, 768, 4)).toEqual({ top: 680, side: 'bottom' }); // 768 − 8 − 680 = 80
  });
  it('어느 쪽도 다 못 담으면 넓은 쪽에 두고 [8, 768 − 8] 안으로 민다', () => {
    expect(placeVertical({ top: 300, bottom: 320 }, 700, 768, 4)).toEqual({ top: 60, side: 'bottom' }); // 아래 436 ≥ 위 288 → 아래 · 324 → 760 − 700
    expect(placeVertical({ top: 500, bottom: 520 }, 700, 768, 4)).toEqual({ top: 8, side: 'top' }); // 위 488 > 아래 236 → 위 · −204 → 8
  });
});

// story #4349 PR 2 — 공용 키보드 훅: 포털이면 DOM 순서상 트리거 뒤가 아니라 예전 Tab 길이 끊긴다 → 그 빈틈만 메운다.
function KeysHarness({ kind, hidden = false }: { kind: 'menu' | 'panel'; hidden?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const keys = usePortalMenuKeys({ open, onClose: () => setOpen(false), popoverRef: popRef, triggerRef, kind });
  return (
    <div id="anchor" ref={anchorRef}>
      <button type="button" id="trig" ref={triggerRef} onClick={() => setOpen((v) => !v)} onKeyDown={keys.onTriggerKeyDown} {...keys.triggerProps}>열기</button>
      {open && (
        <AnchoredPopover anchorRef={anchorRef} popoverRef={popRef} onKeyDown={keys.onPopoverKeyDown} {...keys.popoverProps} data-testid="pop" style={hidden ? { display: 'none' } : undefined}>
          <button type="button" id="i1">하나</button><button type="button" id="i2">둘</button>
        </AnchoredPopover>
      )}
    </div>
  );
}
const byId = (id: string) => document.getElementById(id)!;
const press = (el: Element, key: string, shiftKey = false) => {
  const e = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  act(() => { el.dispatchEvent(e); });
  return e;
};

describe('usePortalMenuKeys(story #4349 PR 2)', () => {
  it('menu: 열면 첫 항목 · ↓↑ 돌아감 · 마지막에서 Tab이면 닫고 트리거', () => {
    act(() => { root.render(<KeysHarness kind="menu" />); });
    act(() => { byId('trig').click(); });
    expect(document.activeElement).toBe(byId('i1'));
    press(byId('i1'), 'ArrowDown');
    expect(document.activeElement).toBe(byId('i2'));
    press(byId('i2'), 'ArrowDown');
    expect(document.activeElement).toBe(byId('i1'));
    press(byId('i1'), 'ArrowUp');
    expect(document.activeElement).toBe(byId('i2'));
    press(byId('i2'), 'Tab');
    expect(document.querySelector('[data-testid="pop"]')).toBeNull();
    expect(document.activeElement).toBe(byId('trig'));
  });

  it('panel: 열어도 초점은 트리거 · 트리거에서 Tab → 첫 조작 · Shift+Tab → 트리거(열린 채) · ↓는 안 옮김', () => {
    act(() => { root.render(<KeysHarness kind="panel" />); });
    byId('trig').focus();
    act(() => { byId('trig').click(); });
    expect(document.activeElement).toBe(byId('trig'));
    expect(press(byId('trig'), 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId('i1'));
    press(byId('i1'), 'ArrowDown');
    expect(document.activeElement).toBe(byId('i1'));
    press(byId('i1'), 'Tab', true);
    expect(document.activeElement).toBe(byId('trig'));
    expect(document.querySelector('[data-testid="pop"]')).not.toBeNull();
  });

  it('안 보이는 패널(display:none — 좁은 화면 벨)로는 트리거 Tab을 안 가로챈다', () => {
    act(() => { root.render(<KeysHarness kind="panel" hidden />); });
    byId('trig').focus();
    act(() => { byId('trig').click(); });
    expect(press(byId('trig'), 'Tab').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byId('trig'));
  });

  it('Esc: 닫고 트리거 · 전파 멈춤(document keydown 트랩 0)', () => {
    const trap = vi.fn();
    document.addEventListener('keydown', trap);
    act(() => { root.render(<KeysHarness kind="menu" />); });
    act(() => { byId('trig').click(); });
    press(byId('i2'), 'Escape');
    document.removeEventListener('keydown', trap);
    expect(document.querySelector('[data-testid="pop"]')).toBeNull();
    expect(document.activeElement).toBe(byId('trig'));
    expect(trap).not.toHaveBeenCalled();
  });

  // story #4355(유나 배포 35) — 열린 채 초점이 **트리거**에 있으면(포인터로 연 패널 · 포인터로 연 뒤 트리거로 돌아온 메뉴) Esc가 무시되거나
  // 서랍 · 셸 트랩(document keydown)까지 가 서랍째 닫혔다. App Router처럼 React 뿌리가 트랩과 같은 노드면 stopPropagation으로는 못 막는다 —
  // 뿌리 노드(여기선 container)에 붙은 트랩도 안 불려야 한다(stopImmediatePropagation).
  it('panel: 열린 채 트리거에서 Esc → 닫힘 · 초점 트리거 · 트랩 0(document · 뿌리와 같은 노드 둘 다)', () => {
    act(() => { root.render(<KeysHarness kind="panel" />); });
    const docTrap = vi.fn(); const rootTrap = vi.fn();
    document.addEventListener('keydown', docTrap);
    container.addEventListener('keydown', rootTrap); // React 뿌리 리스너보다 늦게 붙은 같은 노드 리스너(App Router의 document 뿌리 + 트랩 모양)
    try {
      byId('trig').focus();
      act(() => { byId('trig').click(); });
      expect(document.activeElement).toBe(byId('trig'));
      const e = press(byId('trig'), 'Escape');
      expect(e.defaultPrevented).toBe(true);
      expect(document.querySelector('[data-testid="pop"]')).toBeNull();
      expect(document.activeElement).toBe(byId('trig'));
      expect(docTrap).not.toHaveBeenCalled();
      expect(rootTrap).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', docTrap);
      container.removeEventListener('keydown', rootTrap);
    }
  });

  it('menu: 연 뒤 초점이 트리거로 돌아와도(포인터 뒤 등) Esc → 닫힘 · 트랩 0', () => {
    act(() => { root.render(<KeysHarness kind="menu" />); });
    const docTrap = vi.fn();
    document.addEventListener('keydown', docTrap);
    try {
      act(() => { byId('trig').click(); });
      act(() => { byId('trig').focus(); });
      press(byId('trig'), 'Escape');
      expect(document.querySelector('[data-testid="pop"]')).toBeNull();
      expect(document.activeElement).toBe(byId('trig'));
      expect(docTrap).not.toHaveBeenCalled();
    } finally { document.removeEventListener('keydown', docTrap); }
  });

  it('닫혀 있으면 트리거 Esc를 삼키지 않는다(서랍 Esc 그대로 닿음)', () => {
    act(() => { root.render(<KeysHarness kind="panel" />); });
    const docTrap = vi.fn();
    document.addEventListener('keydown', docTrap);
    try {
      byId('trig').focus();
      const e = press(byId('trig'), 'Escape');
      expect(e.defaultPrevented).toBe(false);
      expect(docTrap).toHaveBeenCalledTimes(1);
    } finally { document.removeEventListener('keydown', docTrap); }
  });

  // 까디르(4724 · 부류) — 훅이 ARIA props도 준다: menu는 메뉴 역할까지, panel은 펼침 · 가리킴만.
  it('ARIA props — menu: aria-haspopup=menu · aria-expanded · aria-controls(열렸을 때 팝오버 id) · 팝오버 role=menu / panel: haspopup · role 없음', () => {
    act(() => { root.render(<KeysHarness kind="menu" />); });
    const trig = byId('trig');
    expect(trig.getAttribute('aria-haspopup')).toBe('menu');
    expect(trig.getAttribute('aria-expanded')).toBe('false');
    expect(trig.hasAttribute('aria-controls')).toBe(false);
    act(() => { trig.click(); });
    const pop = document.querySelector<HTMLElement>('[data-testid="pop"]')!;
    expect(trig.getAttribute('aria-expanded')).toBe('true');
    expect(pop.getAttribute('role')).toBe('menu');
    expect(trig.getAttribute('aria-controls')).toBe(pop.id);
    act(() => { root.unmount(); }); // 같은 root에서 kind만 바꾸면 훅 상태(열림)가 남는다 — 새 root로
    root = createRoot(container);
    act(() => { root.render(<KeysHarness kind="panel" />); });
    const t2 = byId('trig');
    expect(t2.hasAttribute('aria-haspopup')).toBe(false);
    act(() => { t2.click(); });
    const p2 = document.querySelector<HTMLElement>('[data-testid="pop"]')!;
    expect(p2.hasAttribute('role')).toBe(false);
    expect(t2.getAttribute('aria-expanded')).toBe('true');
    expect(t2.getAttribute('aria-controls')).toBe(p2.id);
  });
});

// 유나 #4728 — 바깥 누름 판정 하나(부모 · 포털 주인 모두). 가드: outside-press.guard.test.ts.
describe('isOutsidePress', () => {
  it('root 안 = 바깥 아님 · 포털 팝오버 안(자손 · 글자 노드 포함) = 바깥 아님 · 그 밖 = 바깥 · root 없음 = 바깥 아님', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div id="op-root"><button id="op-in">in</button></div><div data-anchored-popover=""><span id="op-pop">항목</span></div><p id="op-out">out</p>';
    document.body.appendChild(host);
    try {
      const root = document.getElementById('op-root');
      expect(isOutsidePress(root, document.getElementById('op-in'))).toBe(false);
      expect(isOutsidePress(root, document.getElementById('op-pop'))).toBe(false);
      expect(isOutsidePress(root, document.getElementById('op-pop')!.firstChild)).toBe(false);
      expect(isOutsidePress(root, document.getElementById('op-out'))).toBe(true);
      expect(isOutsidePress(null, document.getElementById('op-out'))).toBe(false);
      expect(isOutsidePress(root, null)).toBe(false);
    } finally {
      host.remove();
    }
  });
});

// story #4373(까디르 실측 · 유나 4757 반려 · 부류) — Base UI 모달 팝업(표지 data-modal-popup — 래퍼 둘 + 래퍼 밖 직접 사용 셋) 안 트리거면
// 포털 대상이 그 팝업(Base UI 모달이 팝업 밖 body 자식을 aria-hidden으로 숨기므로). 스스로 그린 role="dialog" 패널(스토리 상세)은 밖을
// 숨기지 않으니 예전처럼 body. 팝업이 fixed의 담는 블록이 되면(transform · translate · backdrop-filter …) 둔 뒤 재서 차이만큼 되민다.
describe('AnchoredPopover — 모달 팝업 안(story #4373)', () => {
  function ModalHarness({ slot, blockOffset }: { slot?: string; blockOffset?: { left: number; top: number } }) {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLDivElement>(null);
    return (
      <div role="dialog" id="modal" data-modal-popup={slot ? "" : undefined} data-block-offset={blockOffset ? JSON.stringify(blockOffset) : undefined}>
        <div id="anchor" ref={open ? anchorRef : undefined}>
          <button type="button" id="trigger" onClick={() => setOpen((v) => !v)}>열기</button>
          {open && <AnchoredPopover anchorRef={anchorRef} id="pop" className="w-56">안내</AnchoredPopover>}
        </div>
      </div>
    );
  }
  // 브라우저처럼: 팝오버 자리는 style.left/top에서 나오고, 담는 블록(팝업)이 있으면 그 왼쪽 위만큼 밀려 보인다 — 어떤 CSS가 그 블록을
  // 만들었는지(transform이든 backdrop-filter든)는 재는 쪽이 모른다. 예전 되밂(transform 읽기)은 이 경우를 못 봤다.
  function mockBrowserLikeRects() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      let r = { left: 0, top: 0, width: 0, height: 0 };
      if (this.id === 'anchor') r = { left: anchorRect.left, top: anchorRect.top, width: anchorRect.right - anchorRect.left, height: 20 };
      if (this.id === 'pop') {
        const offset = JSON.parse(this.parentElement?.getAttribute('data-block-offset') ?? '{"left":0,"top":0}') as { left: number; top: number };
        r = { left: parseFloat(this.style.left || '0') + offset.left, top: parseFloat(this.style.top || '0') + offset.top, width: 224, height: 80 };
      }
      const full = { ...r, right: r.left + r.width, bottom: r.top + r.height };
      return { ...full, x: full.left, y: full.top, toJSON: () => full } as DOMRect;
    });
  }
  const visible = () => pop().getBoundingClientRect();

  it('포털 대상 = Base UI 모달 팝업(data-modal-popup) · 스스로 그린 role=dialog 패널(스토리 상세)은 body', () => {
    act(() => { root.render(<ModalHarness slot="modal" />); });
    act(() => { document.getElementById('trigger')!.click(); });
    expect(pop().parentElement).toBe(document.getElementById('modal'));
    act(() => { document.getElementById('trigger')!.click(); });
    act(() => { root.render(<ModalHarness />); });
    act(() => { document.getElementById('trigger')!.click(); });
    expect(pop().parentElement).toBe(document.body);
    expect(pop().style.left).toBe('100px');
    expect(pop().style.top).toBe('68px');
  });

  it('모달 팝업이 담는 블록이면(transform 없이 backdrop-filter 등이어도) 재서 되밀어 트리거 아래에 보인다 — 예전 transform 되밂이면 RED', () => {
    mockBrowserLikeRects();
    act(() => { root.render(<ModalHarness slot="modal" blockOffset={{ left: 451, top: 12 }} />); });
    act(() => { document.getElementById('trigger')!.click(); });
    expect(pop().parentElement).toBe(document.getElementById('modal'));
    expect(visible().left).toBe(100);  // 트리거 왼쪽
    expect(visible().top).toBe(68);    // 트리거 아래 8px
  });

  it('trackAnchor: 트리거는 그대로인데 담는 블록만 바뀌어도(시트 애니 끝 translate 0 → none) 다음 프레임에 재서 다시 둔다', async () => {
    mockBrowserLikeRects();
    function TrackHarness() {
      const anchorRef = useRef<HTMLDivElement>(null);
      return (
        <div role="dialog" id="modal" data-modal-popup="" data-block-offset={JSON.stringify({ left: 40, top: 0 })}>
          <div id="anchor" ref={anchorRef} />
          <AnchoredPopover anchorRef={anchorRef} trackAnchor id="pop" className="w-56">안내</AnchoredPopover>
        </div>
      );
    }
    act(() => { root.render(<TrackHarness />); });
    await act(async () => { for (let i = 0; i < 2; i += 1) await new Promise((r) => requestAnimationFrame(() => r(null))); });
    expect(visible().left).toBe(100);
    // 담는 블록이 사라짐(팝업 translate none) — 트리거 rect · 자기 크기는 그대로라 예전 trackAnchor(키 = 트리거 · 크기)는 다시 두지 않았다.
    document.getElementById('modal')!.setAttribute('data-block-offset', JSON.stringify({ left: 0, top: 0 }));
    expect(visible().left).toBe(60);  // 되민 값(100 − 40)이 그대로 남아 40px 어긋남
    await act(async () => { for (let i = 0; i < 2; i += 1) await new Promise((r) => requestAnimationFrame(() => r(null))); });
    expect(visible().left).toBe(100);
    expect(visible().top).toBe(68);
  });

  it('시트 미끄러짐(여는 도중) — 담는 블록이 움직여도 매 프레임 재서 트리거에 붙는다', async () => {
    mockBrowserLikeRects();
    act(() => { root.render(<ModalHarness slot="modal" blockOffset={{ left: 40, top: 0 }} />); });
    act(() => { document.getElementById('trigger')!.click(); });
    expect(visible().left).toBe(100);
    // 다음 프레임에 시트가 제자리로(담는 블록 0) — 창 크기 · 스크롤 이벤트로 다시 둘 때도 같은 식.
    document.getElementById('modal')!.setAttribute('data-block-offset', JSON.stringify({ left: 0, top: 0 }));
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(visible().left).toBe(100);
    expect(visible().top).toBe(68);
  });
});
