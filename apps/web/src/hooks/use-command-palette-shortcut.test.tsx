// @vitest-environment jsdom
//
// story 5032 (C2 · PO 11-27) — ⌘K / Ctrl+K toggles the command palette, bound by the SHELL (this hook, mounted by dashboard-shell) — not by the old sidebar component, so taking that column out of the shell cannot take ⌘K with it.
// The test mounts ONLY the hook (no AppSidebar anywhere): if the binding moved back into AppSidebar, every case here goes red.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommandPaletteProvider, useCommandPalette } from '@/components/command-palette/command-palette-context';
import { useCommandPaletteShortcut } from './use-command-palette-shortcut';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useCommandPaletteShortcut();
  const { open } = useCommandPalette();
  return <div><span data-testid="open">{String(open)}</span><div data-testid="editable" contentEditable suppressContentEditableWarning /></div>;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root.render(<CommandPaletteProvider><Probe /></CommandPaletteProvider>); });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const isOpen = () => (container.querySelector('[data-testid="open"]') as HTMLElement).textContent;
function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}

describe('⌘K — the shell opens the palette', () => {
  it('⭐ ⌘K opens it (and stops the browser\'s own handling); a second press closes it', () => {
    expect(isOpen()).toBe('false');
    const e = press({ key: 'k', metaKey: true });
    expect(isOpen()).toBe('true'); // reverted (the binding back inside AppSidebar, not mounted here) → stays false
    expect(e.defaultPrevented).toBe(true);
    press({ key: 'k', metaKey: true });
    expect(isOpen()).toBe('false');
  });

  it('Ctrl+K (Windows · Linux) and a capital K work the same', () => {
    press({ key: 'K', ctrlKey: true });
    expect(isOpen()).toBe('true');
  });

  it('a plain K, Shift-less other letters and ⌘J do nothing', () => {
    press({ key: 'k' });
    press({ key: 'j', metaKey: true });
    expect(isOpen()).toBe('false');
  });

  it('inside a contentEditable surface the key is the editor\'s — the palette stays closed', () => {
    const editable = container.querySelector('[data-testid="editable"]') as HTMLElement;
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    press({ key: 'k', metaKey: true }, editable);
    expect(isOpen()).toBe('false');
  });
});
