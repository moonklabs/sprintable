// @vitest-environment jsdom
//
// story 4831 덮개 — ContextualPanelLayout의 서랍 가지(손으로 지은 role=dialog + 가림막 단추 + useFocusTrap)를 바탕 Sheet로 옮기기 «전»에 현재 동작을 잠근다.
// 이 파일에는 서랍 동작을 잠그는 시험이 하나도 없었다(contextual-panel-layout.test.tsx는 순수 도우미 1건뿐). 현재 코드에서 통과하는 특성화 시험이고,
// 옮기는 PR이 일부러 바꾸는 셋(가림막 모양 · 기본 닫기 단추 · 초점 관리자)만 그 PR에서 이 시험과 함께 고친다. 2xl 이상으로 넓어질 때 서랍이 닫히는 것은 훅(useContextualPanelState)이
// 이미 하고 있어 바뀌지 않는다 — 아래 마지막 시험이 그 동작을 잠근다(옮긴 뒤의 정확성이 거기에 달려 있다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const hasClass = (el: Element, token: string) => el.className.split(/\s+/).includes(token);

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
  await act(async () => { root.render(<Host {...props} />); });
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
async function openByOpener() {
  const opener = document.getElementById('opener') as HTMLButtonElement;
  opener.focus();
  await act(async () => { opener.click(); });
}
async function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  await act(async () => { el.dispatchEvent(ev); });
  return ev;
}

describe('ContextualPanelLayout 서랍 — 덮개 잠금(현재 동작)', () => {
  it('닫혀 있으면 서랍이 없고 본문만 그려진다 · 넓은 화면의 인라인 패널은 서랍과 따로 그려진다', async () => {
    await mount();
    expect(dialog()).toBeNull();
    expect(document.getElementById('body-content')).not.toBeNull();
    expect(document.querySelector('[data-testid="panel-drawer"]')).toBeNull();
    await act(async () => { root.render(<Host inlinePanelOpen />); });
    expect(document.querySelector('[data-testid="panel-inline"]')).not.toBeNull();
    expect(dialog()).toBeNull();
  });

  it('열리면 role=dialog · aria-modal=true · 이름=drawerAriaLabel · tabIndex -1 · 화면 전체(fixed inset-0 z-50)이고 2xl 이상에서는 CSS로 숨는다', async () => {
    await mount({ initialOpen: true });
    const d = dialog()!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.getAttribute('aria-label')).toBe(LABEL);
    expect(d.getAttribute('tabindex')).toBe('-1');
    for (const t of ['fixed', 'inset-0', 'z-50', '2xl:hidden']) expect(hasClass(d, t), t).toBe(true);
  });

  it('서랍 안에 renderPanel({ mode: "drawer" })가 그려지고 본문은 그대로 남는다', async () => {
    await mount({ initialOpen: true });
    const panel = document.querySelector('[data-testid="panel-drawer"]')!;
    expect(dialog()!.contains(panel)).toBe(true);
    expect(document.querySelector('[data-testid="panel-inline"]')).toBeNull();
    expect(document.getElementById('body-content')).not.toBeNull();
  });

  it('서랍 자리 — drawerSide=left는 left-0, right는 right-0에 붙고 폭 클래스를 쓴다(기본 w-[min(92vw,24rem)])', async () => {
    await mount({ initialOpen: true });
    const slot = () => dialog()!.querySelector<HTMLElement>(':scope > div')!;
    expect(hasClass(slot(), 'left-0') && !hasClass(slot(), 'right-0')).toBe(true);
    expect(hasClass(slot(), 'w-[min(92vw,24rem)]')).toBe(true);
    await act(async () => { root.render(<Host initialOpen side="right" width="w-[20rem]" />); });
    expect(hasClass(slot(), 'right-0') && !hasClass(slot(), 'left-0')).toBe(true);
    expect(hasClass(slot(), 'w-[20rem]')).toBe(true);
  });

  it('가림막 단추(이름=drawerAriaLabel)를 누르면 닫힘을 요청한다', async () => {
    const onChange = vi.fn();
    await mount({ initialOpen: true, onChange });
    const scrim = dialog()!.querySelector<HTMLButtonElement>(`:scope > button[aria-label="${LABEL}"]`)!;
    expect(scrim).not.toBeNull();
    await act(async () => { scrim.click(); });
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
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    await key(document.activeElement!, 'Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(document.getElementById('opener'));
  });

  it('Tab은 서랍 안에서 돈다 — 마지막 조작에서 Tab은 첫 조작으로 · 첫 조작에서 Shift+Tab은 마지막으로', async () => {
    await mount();
    await openByOpener();
    const items = [...dialog()!.querySelectorAll<HTMLElement>(FOCUSABLE)];
    expect(items.length).toBeGreaterThan(2);
    items[items.length - 1]!.focus();
    const fwd = await key(items[items.length - 1]!, 'Tab');
    expect(fwd.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    const back = await key(items[0]!, 'Tab', { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[items.length - 1]);
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

// 서랍을 여는 상태는 훅이 쥔다. 넓은 화면(>= 2xl, 인라인 패널을 지원하는 폭)으로 넘어가면 훅이 서랍을 닫는다 — `2xl:hidden`은 그 상태 갱신 직전 한 순간을 가리는 보조일 뿐이다.
// 바탕 Sheet(모달)로 옮기면 CSS로 숨겨도 모달이 열린 채 남으므로 정확성은 이 닫기에 달려 있다.
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
