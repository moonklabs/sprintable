// @vitest-environment jsdom
//
// story 4946 (the desktop app's room) — a FILE dragged over the room shows the drop guide, a drop anywhere in the room goes to the composer as an attachment, and dragover «takes the drop» (without that the browser OPENS the dropped file in
// place of the room). The composer is a mock that mirrors the real contract: it attaches `incomingFiles` by nonce, and its own strip takes a drop itself (`preventDefault` first — a child before its parent).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/chats/thread-1' }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/use-chat-sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-sse')>();
  return { ...actual, useChatSse: () => ({ connected: true, polling: false }) };
});
vi.mock('./chat-input', () => ({
  ChatInput: ({ incomingFiles }: { incomingFiles?: { nonce: number; files: File[] } | null }) => {
    const [attached, setAttached] = useState<string[]>([]);
    const applied = useRef<number | null>(null);
    useEffect(() => {
      if (!incomingFiles || applied.current === incomingFiles.nonce) return;
      applied.current = incomingFiles.nonce;
      setAttached((a) => [...a, ...incomingFiles.files.map((f) => f.name)]);
    }, [incomingFiles]);
    return (
      <div data-testid="mock-input-wrap">
        <div data-testid="mock-strip" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); setAttached((a) => [...a, ...Array.from(e.dataTransfer.files).map((f) => `strip:${f.name}`)]); }}>strip</div>
        <output data-testid="mock-attached">{attached.join('|')}</output>
      </div>
    );
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (typeof url === 'string' && url.includes('/messages?') ? { ok: true, json: async () => ({ data: [], meta: { next_cursor: null, has_more: false } }) } : { ok: true, json: async () => ({ data: [] }) })));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function mount() {
  const { ChatView } = await import('./chat-view');
  const { ChatRailProvider } = await import('../../app/(authenticated)/chats/chat-rail-context');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatRailProvider><ChatView threadId="thread-1" currentTeamMemberId="me-1" /></ChatRailProvider></NextIntlClientProvider>); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const column = () => container.querySelector('div.relative.flex.min-w-0.flex-1') as HTMLElement;
const overlay = () => container.querySelector('[data-testid="room-drop-overlay"]') as HTMLElement | null;
const attached = () => container.querySelector('[data-testid="mock-attached"]')!.textContent;
const file = (name: string) => new File(['x'], name, { type: 'image/png' });
function drag(el: Element, type: string, files: File[] | null = [file('a.png')], types: string[] = ['Files']) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { types, files: files ?? [] } });
  return e;
}
const fire = async (el: Element, e: Event) => { await act(async () => { el.dispatchEvent(e); }); return e; };

describe('[SID:4946] ChatView — a file over the room shows the drop guide; a drop anywhere in it attaches', () => {
  it('⭐dragenter with a FILE shows the guide («여기에 놓으면 첨부돼요»), dragleave hides it; a text drag shows nothing', async () => {
    await mount();
    expect(overlay()).toBeNull();
    await fire(column(), drag(column(), 'dragenter', null, ['text/plain'])); expect(overlay()).toBeNull();
    await fire(column(), drag(column(), 'dragenter')); expect(overlay()).not.toBeNull();
    expect(overlay()!.textContent).toBe(koMessages.chats.dropToAttach);
    expect(overlay()!.getAttribute('role')).toBe('status');
    await fire(column(), drag(column(), 'dragleave')); expect(overlay()).toBeNull();
  });
  it('⭐enter / leave fire on every child: the guide stays while the file is still inside the room (depth), and goes only when it has left', async () => {
    await mount();
    const inner = container.querySelector('[data-testid="mock-input-wrap"]')!;
    await fire(column(), drag(column(), 'dragenter')); await fire(inner, drag(inner, 'dragenter'));
    await fire(column(), drag(column(), 'dragleave')); expect(overlay()).not.toBeNull(); // left the column's own box, still over the child
    await fire(inner, drag(inner, 'dragleave')); expect(overlay()).toBeNull();
  });
  it('⭐dragover with a file «takes the drop» (preventDefault — else the browser opens the file in place of the room); a text drag does not', async () => {
    await mount();
    expect((await fire(column(), drag(column(), 'dragover'))).defaultPrevented).toBe(true);
    expect((await fire(column(), drag(column(), 'dragover', null, ['text/plain']))).defaultPrevented).toBe(false);
  });
  it('⭐a drop on the room (the messages) goes to the composer as an attachment, once, and the guide goes; the same file dropped again counts again (a new nonce)', async () => {
    await mount();
    await fire(column(), drag(column(), 'dragenter'));
    const dropped = await fire(column(), drag(column(), 'drop', [file('report.pdf')]));
    expect(dropped.defaultPrevented).toBe(true); expect(overlay()).toBeNull();
    expect(attached()).toBe('report.pdf');
    await fire(column(), drag(column(), 'drop', [file('report.pdf')]));
    expect(attached()).toBe('report.pdf|report.pdf');
  });
  it('⭐a drop on the composer\'s OWN strip is taken there and NOT added a second time by the room', async () => {
    await mount();
    const strip = container.querySelector('[data-testid="mock-strip"]')!;
    await fire(column(), drag(column(), 'dragenter'));
    await fire(strip, drag(strip, 'drop', [file('twice.png')]));
    expect(attached()).toBe('strip:twice.png'); // the strip's, once — not also «twice.png» from the room
    expect(overlay()).toBeNull();
  });
  it('a drop with no files (text) is ignored: nothing attached, not prevented', async () => {
    await mount();
    const e = await fire(column(), drag(column(), 'drop', null, ['text/plain']));
    expect(attached()).toBe(''); expect(e.defaultPrevented).toBe(false);
  });
});
