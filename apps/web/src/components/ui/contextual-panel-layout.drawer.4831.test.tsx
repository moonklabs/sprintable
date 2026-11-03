// @vitest-environment jsdom
//
// story 4831 덮개 — ContextualPanelLayout의 서랍 가지를 손으로 지은 role=dialog + 가림막 단추 + useFocusTrap에서 바탕 Sheet로 옮겼다(앞 PR이 옮기기 «전» 동작을 이 파일에 먼저 박았다).
// 이 파일은 옮긴 «뒤»에도 그대로 지켜지는 것과, 옮기며 일부러 바뀐 것을 가른다.
//   그대로: 모달 대화상자 · 이름 · renderPanel 서랍 모드 · 좌우 자리와 폭 · 가림막을 누르면 닫힘 · 패널이 받은 closePanel · 초점 진입과 반환 · Esc(한 Esc = 한 층 · 조합 중 Esc)
//   일부러 바뀐 것(눈에 보이는 변화): ① 가림막은 Sheet 기본(sheet-overlay) — 옛 단추 가림막(scrim-2 + 2px 블러) 대신 ② Sheet 기본 닫기 단추는 끔(패널이 자기 닫기를 가진다)
//   ③ 초점·모달 관리는 Base UI — Tab을 키로 가로채는 대신 초점 가드가 가두고, aria-modal 속성 대신 바깥 내용을 비활성 처리하며, 열려 있는 동안 페이지 뒤 스크롤을 잠근다(Base UI의 스크롤 잠금은 환경별 경로라 jsdom 시험이 아니라 실제 Chromium 비교로 쟀다 — PR 본문)
//   ④ 나타날 때 Sheet 기본 전환(페이드 + 슬라이드) ⑤ 서랍이 body 포털로 나가 우하단 도크(토스트 · 상담 런처) 위로 올라온다(옛 서랍은 셸 트리 안이라 도크 아래였다)
//   2xl 이상으로 넓어질 때 서랍이 닫히는 것은 훅(useContextualPanelState)이 하던 일이라 바뀌지 않는다 — 마지막 시험이 잠근다(모달은 CSS로 숨겨도 열려 남으므로 이 닫기가 정확성의 핵심이다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ContextualPanelLayout, useContextualPanelState } from './contextual-panel-layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const LABEL = '팀 현황';
const hasClass = (el: Element, token: string) => el.className.split(/\s+/).includes(token);
const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;

interface HostProps {
  initialOpen?: boolean;
  inlinePanelOpen?: boolean;
  side?: 'left' | 'right';
  width?: string;
  onChange?: (open: boolean) => void;
}
// 호출부(dashboard-shell · policy-doc-browser)처럼 서랍 열림 상태를 부모가 쥔다.
function Host({ initialOpen = false, inlinePanelOpen = false, side, width, onChange }: HostProps) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" id="opener" onClick={() => setOpen(true)}>열기</button>
      <ContextualPanelLayout
        renderPanel={({ mode, closePanel }) => (
          <div data-mode={mode} data-testid={`panel-${mode}`}>
            <button type="button" id="p-first">첫 조작</button>
            <input id="p-input" aria-label="입력" />
            <button type="button" id="p-last" onClick={closePanel}>패널 닫기</button>
          </div>
        )}
        inlinePanelOpen={inlinePanelOpen}
        drawerOpen={open}
        onDrawerOpenChange={(o) => { onChange?.(o); setOpen(o); }}
        drawerAriaLabel={LABEL}
        drawerSide={side}
        drawerWidthClassName={width}
      >
        <p id="body-content">본문</p>
      </ContextualPanelLayout>
    </>
  );
}

async function mount(props: HostProps = {}) {
  await act(async () => { root.render(wrap(<Host {...props} />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
async function openByOpener() {
  const opener = document.getElementById('opener') as HTMLButtonElement;
  opener.focus();
  await act(async () => { opener.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
async function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  await act(async () => { el.dispatchEvent(ev); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return ev;
}
// 초점 이동은 열린 뒤 비동기로 일어난다 — 조건이 참이 될 때까지 기다린다(고정 횟수의 microtask는 부하에 따라 모자라 흔들린다)
async function until(cond: () => boolean) {
  for (let i = 0; i < 40 && !cond(); i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
}

describe('ContextualPanelLayout 서랍 — 덮개 잠금(Sheet로 옮긴 뒤)', () => {
  it('닫혀 있으면 서랍이 없고 본문만 그려진다 · 넓은 화면의 인라인 패널은 서랍과 따로 그려진다', async () => {
    await mount();
    expect(dialog()).toBeNull();
    expect(document.getElementById('body-content')).not.toBeNull();
    expect(document.querySelector('[data-testid="panel-drawer"]')).toBeNull();
    await act(async () => { root.render(wrap(<Host inlinePanelOpen />)); });
    expect(document.querySelector('[data-testid="panel-inline"]')).not.toBeNull();
    expect(dialog()).toBeNull();
  });

  it('열리면 모달 role=dialog이고 이름=drawerAriaLabel · tabIndex -1 · 화면 위(fixed z-50)이며, 2xl:hidden은 더 이상 없다(닫기는 훅이 한다)', async () => {
    await mount({ initialOpen: true });
    const d = dialog()!;
    expect(d.getAttribute('aria-label')).toBe(LABEL);
    expect(d.getAttribute('tabindex')).toBe('-1');
    expect(d.getAttribute('data-slot')).toBe('sheet-content');
    for (const t of ['fixed', 'z-50']) expect(hasClass(d, t), t).toBe(true);
    expect(hasClass(d, '2xl:hidden')).toBe(false); // 모달은 CSS로 숨겨도 열려 남는다 — 넓은 화면에서는 훅이 닫는다(마지막 시험)
  });

  it('모달이다 — 서랍이 열려 있는 동안 바깥 내용은 비활성 처리된다(aria-modal 속성 대신 Base UI가 바깥을 inert · aria-hidden으로)', async () => {
    await mount();
    expect(container.hasAttribute('inert') || container.getAttribute('aria-hidden') === 'true').toBe(false); // 열기 전에는 아니다
    await openByOpener();
    const dis = (el: Element) => el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('data-base-ui-inert');
    expect(dis(container)).toBe(true);
    expect(dialog()!.closest('[aria-hidden="true"], [inert]')).toBeNull(); // 서랍 자신은 비활성이 아니다
  });

  it('서랍은 호출부 트리 밖(body 포털)에 그려진다 — 우하단 도크(토스트 · 상담 런처)보다 위로 올라온다', async () => {
    await mount({ initialOpen: true });
    expect(container.contains(dialog())).toBe(false);
    expect(document.body.contains(dialog())).toBe(true);
  });

  it('서랍 안에 renderPanel({ mode: "drawer" })가 그려지고 본문은 그대로 남는다', async () => {
    await mount({ initialOpen: true });
    const panel = document.querySelector('[data-testid="panel-drawer"]')!;
    expect(dialog()!.contains(panel)).toBe(true);
    expect(document.querySelector('[data-testid="panel-inline"]')).toBeNull();
    expect(document.getElementById('body-content')).not.toBeNull();
  });

  it('서랍 자리 — drawerSide=left/right가 Sheet의 data-side로 가고, 폭 클래스는 안쪽 칸이 쓴다(기본 w-[min(92vw,24rem)])', async () => {
    await mount({ initialOpen: true });
    const slot = () => dialog()!.firstElementChild as HTMLElement;
    expect(dialog()!.getAttribute('data-side')).toBe('left');
    expect(hasClass(slot(), 'w-[min(92vw,24rem)]')).toBe(true);
    expect(hasClass(slot(), 'p-3')).toBe(true); // 안쪽 여백 12px는 폭 «안»에 든다(카드 = 폭 − 24px — 옛 서랍과 같게. 껍데기에 주면 카드가 24px 넓어진다)
    expect(hasClass(dialog()!, 'p-3')).toBe(false);
    await act(async () => { root.render(wrap(<Host initialOpen side="right" width="w-[20rem]" />)); });
    expect(dialog()!.getAttribute('data-side')).toBe('right');
    expect(hasClass(slot(), 'w-[20rem]')).toBe(true);
  });

  it('Sheet는 투명 껍데기다 — 패널(GlassPanel)이 자기 카드 면을 가져서 서랍 면 · 테두리 · 그림자를 얹지 않는다(카드 위에 카드가 아님)', async () => {
    await mount({ initialOpen: true });
    const d = dialog()!;
    expect(hasClass(d, 'bg-transparent')).toBe(true);
    expect(hasClass(d, 'bg-popover')).toBe(false);
    expect(hasClass(d, '!shadow-none')).toBe(true); // tailwind-merge가 shadow-[var(--elev-overlay)]와 shadow-none을 합치지 않아 둘 다 남는다 — 중요 표시로 CSS 순서에 안 기대게 한다
    expect(hasClass(d, 'data-[side=left]:border-r-0')).toBe(true);
    expect(d.querySelector('[data-slot="sheet-close"]')).toBeNull(); // Sheet 기본 닫기 단추는 끈다 — 패널이 자기 닫기를 가진다
  });

  it('가림막이 바탕 sheet-overlay 부품이다(손으로 쓴 가림막 단추가 아님)', async () => {
    await mount({ initialOpen: true });
    const overlay = document.querySelector<HTMLElement>('[data-slot="sheet-overlay"]')!;
    expect(overlay).not.toBeNull();
    expect(hasClass(overlay, 'fixed') && hasClass(overlay, 'inset-0')).toBe(true);
    expect(dialog()!.querySelector(`button[aria-label="${LABEL}"]`)).toBeNull(); // 옛 가림막 단추는 없다
  });

  it('가림막을 누르면 닫힘을 요청한다', async () => {
    const onChange = vi.fn();
    await mount({ initialOpen: true, onChange });
    const overlay = document.querySelector<HTMLElement>('[data-slot="sheet-overlay"]')!;
    await act(async () => { overlay.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); overlay.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(onChange).toHaveBeenCalledWith(false);
    expect(dialog()).toBeNull();
  });

  it('패널이 받은 closePanel을 부르면 서랍이 닫힌다', async () => {
    const onChange = vi.fn();
    await mount({ initialOpen: true, onChange });
    await act(async () => { (document.getElementById('p-last') as HTMLButtonElement).click(); });
    expect(onChange).toHaveBeenCalledWith(false);
    expect(dialog()).toBeNull();
  });

  it('열면 초점이 서랍 안으로 들어가고, 닫으면 연 자리(열기 단추)로 돌아간다', async () => {
    await mount();
    await openByOpener();
    await until(() => !!dialog()?.contains(document.activeElement));
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    await key(document.activeElement!, 'Escape');
    await until(() => dialog() === null);
    expect(dialog()).toBeNull();
    await until(() => document.activeElement === document.getElementById('opener'));
    expect(document.activeElement).toBe(document.getElementById('opener'));
  });

  it('초점은 서랍을 벗어나지 못한다 — 서랍 앞뒤의 초점 가드로 초점이 가면 서랍 안으로 되돌아온다(Tab 순환과 같은 효과)', async () => {
    await mount();
    await openByOpener();
    await until(() => !!dialog()?.contains(document.activeElement));
    const guards = [...document.querySelectorAll<HTMLElement>('[data-base-ui-focus-guard]')];
    expect(guards.length).toBeGreaterThanOrEqual(2);
    for (const g of [guards[0]!, guards[guards.length - 1]!]) {
      await act(async () => { g.focus(); });
      await until(() => !!dialog()?.contains(document.activeElement));
      expect(dialog()!.contains(document.activeElement), '가드 뒤 초점').toBe(true);
    }
  });

  it('Esc는 서랍을 닫는다 — 단, 안쪽 층이 이미 쓴 Esc(preventDefault)와 한글 조합 중 Esc는 닫지 않는다(한 Esc = 한 층)', async () => {
    const onChange = vi.fn();
    await mount({ onChange });
    await openByOpener();
    const inner = document.getElementById('p-first')!;
    inner.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    await key(inner, 'Escape'); // 안쪽 층이 쓴 Esc
    expect(onChange).not.toHaveBeenCalledWith(false);
    expect(dialog()).not.toBeNull();
    await key(inner, 'Escape', { isComposing: true }); // 조합 중
    expect(dialog()).not.toBeNull();
    await key(inner, 'Escape'); // 표시 없는 Esc
    expect(onChange).toHaveBeenCalledWith(false);
    expect(dialog()).toBeNull();
  });
});

// 서랍을 여는 상태는 훅이 쥔다. 넓은 화면(>= 2xl, 인라인 패널을 지원하는 폭)으로 넘어가면 훅이 서랍을 닫는다.
// 바탕 Sheet(모달)는 CSS로 숨겨도 열려 남으므로 서랍의 정확성은 이 닫기에 달려 있다.
describe('useContextualPanelState — 넓은 화면으로 넘어가면 서랍을 닫는다', () => {
  let listeners: Array<(e: { matches: boolean }) => void>;
  beforeEach(() => {
    listeners = [];
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => { listeners.push(cb); },
      removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => { listeners = listeners.filter((l) => l !== cb); },
    })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function Probe() {
    const p = useContextualPanelState({ defaultOpen: false });
    return (
      <div>
        <button type="button" id="probe-open" onClick={p.openPanel}>열기</button>
        <span id="probe-state">{`drawer=${p.drawerOpen} inline=${p.supportsInlinePanel}`}</span>
      </div>
    );
  }
  const state = () => document.getElementById('probe-state')!.textContent;

  it('좁은 화면에서 서랍을 열고, 2xl 이상으로 넘어가면 닫히며 인라인 지원으로 바뀌고, 다시 좁아져도 서랍이 되살아나지 않는다', async () => {
    await act(async () => { root.render(<Probe />); });
    expect(state()).toBe('drawer=false inline=false');
    await act(async () => { (document.getElementById('probe-open') as HTMLButtonElement).click(); });
    expect(state()).toBe('drawer=true inline=false');
    await act(async () => { listeners.forEach((l) => l({ matches: true })); });
    expect(state()).toBe('drawer=false inline=true');
    await act(async () => { listeners.forEach((l) => l({ matches: false })); });
    expect(state()).toBe('drawer=false inline=false'); // 닫힌 채 — 서랍이 CSS로만 숨어 있다 되살아나는 일은 없다
  });
});
