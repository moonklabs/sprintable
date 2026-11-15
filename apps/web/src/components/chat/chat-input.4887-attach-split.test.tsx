// @vitest-environment jsdom
//
// story 4887 (UI-4 P5-a · AC3 «클립 분할») — the attach button is SPLIT: the clip opens the file window at once (one action), and the ▾ beside it holds «스토리지에서 선택». It was a menu first (clip → «파일 업로드» → file window).
// What stays: the cap on attachments, the «no project» rule of the storage picker, the disabled composer. jsdom turns no key press into a click and opens no file window, so what a keyboard and a finger do on the real button is measured in Chromium
// (e2e/chat-input-attach-split.4887.layout.spec.ts); these pin the wiring: which element, which name, what a click starts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatInput } from './chat-input';
import { invalidateOrgDomainLabels } from '@/hooks/use-org-domain-labels';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
// the storage picker is its own component (it fetches assets): here a stand-in with the two ways the real one closes — Escape in its search field, and a click outside — so what is tested is the composer's focus handling
vi.mock('./asset-picker-popover', () => ({
  AssetPickerPopover: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="picker">
      <input data-testid="picker-search" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }} />
      <button type="button" data-testid="picker-outside" onClick={onClose}>outside</button>
      <button type="button" data-testid="picker-row">a row (no key handler of its own — like the real scope buttons and asset rows)</button>
    </div>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  invalidateOrgDomainLabels();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList));
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function render(o: { disabled?: boolean; projectId?: string } = {}) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatInput onSend={async () => {}} onUploadFile={async (f) => ({ url: 'u', name: f.name, content_type: f.type, size: f.size })} threadId="t1" projectId={o.projectId} disabled={o.disabled} /></NextIntlClientProvider>);
  });
}
const clip = () => container.querySelector('[data-testid="chat-attach-upload"]') as HTMLButtonElement;
const more = () => container.querySelector('[data-testid="chat-attach-more"]') as HTMLButtonElement;
const fileInput = () => container.querySelector('input[type=file]') as HTMLInputElement;
const clickEl = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };

describe('ChatInput — the split attach button (story 4887 · UI-4 P5-a)', () => {
  it('⭐ ONE click on the clip opens the file window — no menu between (it was clip → «파일 업로드» → the window)', async () => {
    await render();
    const spy = vi.spyOn(fileInput(), 'click');
    await clickEl(clip());
    expect(spy).toHaveBeenCalledTimes(1); // reverted (the clip opens a menu) → 0
    expect(document.querySelector('[role=menu]'), 'no menu opened').toBeNull();
  });

  it('⭐ the clip is a plain <button type=button> named «파일 업로드» — what Enter and Space press natively — and the ▾ is a second, separate control named «첨부»', async () => {
    await render();
    expect(clip().tagName).toBe('BUTTON');
    expect(clip().getAttribute('type')).toBe('button');
    expect(clip().getAttribute('aria-label')).toBe(koMessages.chats.attachMenuUpload);
    expect(more().getAttribute('aria-label')).toBe(koMessages.chats.attachMenuLabel);
    expect(clip()).not.toBe(more());
    expect(clip().contains(more()) || more().contains(clip()), 'the two are siblings, not nested').toBe(false);
  });

  it('⭐ the ▾ holds the storage picker, and only that: «스토리지에서 선택» (the upload is the clip now)', async () => {
    await render({ projectId: 'p1' });
    await clickEl(more());
    const items = [...document.querySelectorAll('[role=menuitem]')].map((e) => (e.textContent ?? '').trim());
    expect(items).toEqual([koMessages.chats.attachMenuStorage]); // reverted (both items in the menu) → two
  });

  it('a room with no project: the storage item is disabled (the picker needs a project) and the clip still uploads', async () => {
    await render({ projectId: undefined });
    await clickEl(more());
    const item = document.querySelector('[role=menuitem]') as HTMLElement;
    expect(item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('data-disabled')).toBe(true);
    const spy = vi.spyOn(fileInput(), 'click');
    await clickEl(clip());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a disabled composer disables both controls', async () => {
    await render({ disabled: true });
    expect(clip().disabled).toBe(true);
    expect(more().disabled).toBe(true);
  });

  it('⭐ at the cap of attachments the clip is disabled (nothing more can be added) — the ▾ stays for the picker\'s own message', async () => {
    await render({ projectId: 'p1' });
    const files = Array.from({ length: 10 }, (_, i) => new File(['x'], `f${i}.txt`, { type: 'text/plain' }));
    Object.defineProperty(fileInput(), 'files', { configurable: true, value: files });
    await act(async () => { fileInput().dispatchEvent(new Event('change', { bubbles: true })); });
    expect(clip().disabled, 'the clip is off at the cap').toBe(true); // reverted (the cap not read) → false
    expect(more().disabled).toBe(false);
  });
  it('⭐ the ▾ → «스토리지에서 선택» opens the picker (the item was only checked to EXIST before)', async () => {
    await render({ projectId: 'p1' });
    await clickEl(more());
    const item = document.querySelector('[role=menuitem]') as HTMLElement;
    await clickEl(item);
    expect(document.querySelector('[data-testid="picker"]'), 'the picker is open').not.toBeNull(); // reverted (the item does nothing) → null
  });

  it('⭐ Escape in the picker closes it AND puts focus back on the ▾ that opened it — not the page', async () => {
    await render({ projectId: 'p1' });
    await clickEl(more());
    await clickEl(document.querySelector('[role=menuitem]') as HTMLElement);
    const search = document.querySelector('[data-testid="picker-search"]') as HTMLInputElement;
    search.focus();
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[data-testid="picker"]'), 'the picker is closed').toBeNull();
    expect(document.activeElement, 'focus is on the ▾').toBe(more()); // reverted (nothing restores it) → body
  });

  it('a click OUTSIDE the picker closes it WITHOUT pulling the focus to the ▾ — wherever the person clicked keeps it (here: the text box)', async () => {
    await render({ projectId: 'p1' });
    await clickEl(more());
    await clickEl(document.querySelector('[role=menuitem]') as HTMLElement);
    const box = container.querySelector('textarea') as HTMLTextAreaElement;
    box.focus(); // the click outside landed in the text box
    await clickEl(document.querySelector('[data-testid="picker-outside"]') as HTMLElement); // the picker's «outside» close
    expect(document.querySelector('[data-testid="picker"]')).toBeNull();
    expect(document.activeElement, 'the text box keeps the focus').toBe(box); // reverted (every close sends focus to the ▾) → the ▾
  });
  it('⭐ Escape on ANOTHER element inside the picker (a row, not the search field) closes it too and puts focus on the ▾ — it must not move focus and leave the picker open', async () => {
    await render({ projectId: 'p1' });
    await clickEl(more());
    await clickEl(document.querySelector('[role=menuitem]') as HTMLElement);
    const row = document.querySelector('[data-testid="picker-row"]') as HTMLButtonElement;
    row.focus();
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => { row.dispatchEvent(esc); });
    expect(document.querySelector('[data-testid="picker"]'), 'the picker is closed').toBeNull(); // reverted (the wrapper only moves focus) → the picker stays open
    expect(document.activeElement, 'focus is on the ▾').toBe(more());
    expect(esc.defaultPrevented, 'the Escape is marked USED — one Escape closes one layer: an enclosing drawer\'s focus trap (use-focus-trap, story 4367) reads defaultPrevented and stays open').toBe(true); // reverted (not consumed) → false
  });

  it('an Escape that is NOT consumed here (an IME composition) is left unmarked, for the composition and any outer layer to handle', async () => {
    await render({ projectId: 'p1' });
    await clickEl(more());
    await clickEl(document.querySelector('[role=menuitem]') as HTMLElement);
    const row = document.querySelector('[data-testid="picker-row"]') as HTMLButtonElement;
    row.focus();
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true });
    await act(async () => { row.dispatchEvent(esc); });
    expect(esc.defaultPrevented).toBe(false);
  });
  it('⭐ Escape pressed WHILE AN IME COMPOSES (isComposing / keyCode 229) is the IME\'s: it neither closes the picker nor moves focus to the ▾', async () => {
    await render({ projectId: 'p1' });
    await clickEl(more());
    await clickEl(document.querySelector('[role=menuitem]') as HTMLElement);
    const row = document.querySelector('[data-testid="picker-row"]') as HTMLButtonElement;
    row.focus();
    await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })); });
    expect(document.querySelector('[data-testid="picker"]'), 'the picker stays open').not.toBeNull(); // reverted (no IME guard) → closed
    expect(document.activeElement, 'focus did not move').toBe(row);
    await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 229 })); });
    expect(document.querySelector('[data-testid="picker"]'), 'keyCode 229 too').not.toBeNull();
  });
  it('⭐ while the ▾ menu is open the WHOLE split carries the info tint — the clip too (the ds IconButton paints its own ink, so the tint is passed on to it)', async () => {
    await render({ projectId: 'p1' });
    expect(clip().className).not.toContain('text-info'); // closed: neutral
    await clickEl(more());
    expect(clip().className, 'the clip is tinted while the menu is open').toContain('text-info'); // reverted (only the container is tinted) → the clip stays neutral
  });
});
