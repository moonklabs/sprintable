// @vitest-environment jsdom
//
// story 4887 (UI-4 P5-a, codex round 4) — the picker's search field: a key pressed while an IME composes is the IME's. Escape cancels the composition and Enter confirms the syllable — neither may close the picker or pick an asset (the composer's own text box has guarded this since story 4831).
// The non-composing keys keep working (asset-picker-popover.4831.test.tsx locks them).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AssetPickerPopover } from './asset-picker-popover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS = [{ id: 'a1', name: '기획서.pdf', content_type: 'application/pdf', size_bytes: 2048 }];
let container: HTMLDivElement;
let root: Root;
const originalScrollIntoView = Element.prototype.scrollIntoView as typeof Element.prototype.scrollIntoView | undefined;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { items: ITEMS } }) })));
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals();
  if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView; else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

async function mountPicker() {
  const onSelect = vi.fn(); const onClose = vi.fn();
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AssetPickerPopover projectId="proj-1" onSelect={onSelect as never} onClose={onClose} /></NextIntlClientProvider>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); }); // the results arrive
  return { onSelect, onClose };
}
const input = () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const press = (init: KeyboardEventInit) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });

describe('AssetPickerPopover — a composing key is the IME\'s (story 4887 · P5-a)', () => {
  it('⭐ Escape while an IME composes (isComposing, or keyCode 229) does NOT close the picker', async () => {
    const { onClose } = await mountPicker();
    await press({ key: 'Escape', isComposing: true });
    await press({ key: 'Escape', keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled(); // reverted (no IME guard) → called
  });

  it('⭐ Enter while an IME composes does NOT pick the highlighted asset (it confirms the syllable)', async () => {
    const { onSelect } = await mountPicker();
    await press({ key: 'Enter', isComposing: true });
    expect(onSelect).not.toHaveBeenCalled(); // reverted → called with the first asset
  });

  it('the same keys without a composition still work: Escape closes, Enter picks', async () => {
    const { onClose, onSelect } = await mountPicker();
    await press({ key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    await press({ key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
