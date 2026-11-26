// @vitest-environment jsdom
//
// story 5031 (C1 step 3) — ⌘1 · ⌘2 · ⌘3 · ⌘4 (Ctrl on Windows / Linux) open the four places 홈 · 채팅 · 에이전트 · 설정. The key handling is in the page (hooks/use-depth1-shortcuts.ts), so the desktop app — the web in a window —
// gets it without a native menu; a real Electron window is deliberately not opened here (the shared Mac screen · lane rule) — this runs the same keydown path in jsdom.
// Reverting the hook, a key, the modifier rule or the editable-surface rule turns a case red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (href: string) => `${href}?p=P` })); // not the identity: a regression to a bare router.push(place.path) must fail
const { useDepth1Shortcuts } = await import('./use-depth1-shortcuts');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useDepth1Shortcuts();
  return <textarea data-testid="field" />;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  push.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function mount() { await act(async () => { root.render(<Probe />); }); }
function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}

describe('⌘1~⌘4 — 1뎁스 넷', () => {
  it.each([
    ['1', '/org-briefing?p=P'], ['2', '/chats?p=P'], ['3', '/organization/workforce?p=P'], ['4', '/settings?p=P'],
  ])('⭐⌘%s → %s 으로 간다(막는 기본 동작도 막는다)', async (key, path) => {
    await mount();
    const e = press({ key, metaKey: true });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(path);
    expect(e.defaultPrevented).toBe(true);
  });

  it('Windows · Linux는 Ctrl이다(Ctrl+3 → 에이전트)', async () => {
    await mount();
    press({ key: '3', ctrlKey: true });
    expect(push).toHaveBeenCalledWith('/organization/workforce?p=P');
  });

  it.each([
    ['Shift가 같이 눌림', { key: '1', metaKey: true, shiftKey: true }],
    ['Alt가 같이 눌림', { key: '2', metaKey: true, altKey: true }],
    ['⌘ 없이 숫자만', { key: '2' }],
    ['5는 자리가 없다', { key: '5', metaKey: true }],
    ['0도 아니다', { key: '0', metaKey: true }],
    ['한글 등 입력기가 글자를 조립하는 중(isComposing)', { key: '2', metaKey: true, isComposing: true }],
  ] as const)('⭐아무 일도 없다: %s', async (_name, init) => {
    await mount();
    const e = press({ ...init });
    expect(push).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('글쓰기 영역(contentEditable)이 초점이면 ⌘K와 같이 비켜 준다 — 글 쓰는 중에 화면이 바뀌지 않는다', async () => {
    await mount();
    const editor = document.createElement('div');
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    document.body.appendChild(editor);
    const e = press({ key: '2', metaKey: true }, editor);
    editor.remove();
    expect(push).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('일반 입력칸(textarea)은 막지 않는다 — ⌘1~4는 글자가 아니다', async () => {
    await mount();
    const field = container.querySelector('[data-testid="field"]')!;
    press({ key: '4', metaKey: true }, field);
    expect(push).toHaveBeenCalledWith('/settings?p=P');
  });

  it('화면이 사라지면(unmount) 키 처리도 거둬진다 — 남은 리스너가 없다', async () => {
    await mount();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    press({ key: '1', metaKey: true });
    expect(push).not.toHaveBeenCalled();
  });
});
