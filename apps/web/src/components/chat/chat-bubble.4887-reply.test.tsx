// @vitest-environment jsdom
//
// story 4887 (UI-4 P6-a · AC3 «답글 아이콘 상시») — the first reply used to sit behind a right-click / «⋯» menu (two hands). ONE reply control now opens the thread: a MOUSE twin beside the bubble (hover / keyboard-focus reveal) and a TOUCH twin in the time line right beside «⋯» (always shown, 44 × 44).
// Each twin is display:none exactly where the other shows. Neither is drawn where no thread can be opened (inside a thread). The accessible name says WHOSE message. jsdom draws no layout, so these pin the elements and the classes that carry the decisions; e2e/chat-bubble-reply.4887.layout.spec.ts measures them in Chromium.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ChatBubble } from './chat-bubble';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectId: 'proj-1', currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member', projectMemberships: [] }),
}));
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src?: string; alt?: string }) =>
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const message = (o: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', memo_id: 'conv-1', created_by: 'agent-1', sender_name: '개발 에이전트', sender_type: 'agent', sender_avatar_url: null, sender_runtime_type: null,
  content: '안녕하세요', attachments: [], created_at: '2026-11-10T01:00:00.000Z', ...o,
});
async function render(o: { message?: ChatMessage; plainRow?: boolean; isMine?: boolean; isGrouped?: boolean; onOpenThread?: ((m: ChatMessage) => void) | null; locale?: 'ko' | 'en' } = {}) {
  const loc = o.locale ?? 'ko'; const msgs = loc === 'ko' ? koMessages : enMessages;
  const m = o.message ?? message();
  await act(async () => {
    root.render(<NextIntlClientProvider locale={loc} messages={msgs} timeZone="Asia/Seoul"><ChatBubble message={m} plainRow={o.plainRow} isMine={o.isMine ?? false} isGrouped={o.isGrouped ?? false} onOpenThread={o.onOpenThread === null ? undefined : (o.onOpenThread ?? (() => {}))} /></NextIntlClientProvider>);
  });
}
const btn = () => container.querySelector('[data-testid="chat-bubble-reply-button"]') as HTMLButtonElement | null;
const btnTouch = () => container.querySelector('[data-testid="chat-bubble-reply-button-touch"]') as HTMLButtonElement | null;
const MOUSE = '[@media(pointer:fine)_and_(hover:hover)]';

describe('ChatBubble — the reply button (story 4887 · UI-4 P6-a)', () => {
  it('⭐ a message with NO replies yet has a reply button — the first reply is one hand, not a menu (a mouse twin AND a touch twin)', async () => {
    await render();
    expect(btn(), 'the mouse twin').not.toBeNull(); // reverted (only the menu opens a thread) → null
    expect(btnTouch(), 'the touch twin').not.toBeNull();
    for (const b of [btn()!, btnTouch()!]) { expect(b.tagName).toBe('BUTTON'); expect(b.getAttribute('type')).toBe('button'); }
  });

  it('⭐ the touch twin lives in the time line right beside «⋯» (one row-local cluster); the mouse twin is in the column', async () => {
    await render();
    const meta = container.querySelector('[data-testid="bubble-meta-line"]') as HTMLElement;
    expect(meta.contains(btnTouch()), 'in the time line').toBe(true); // reverted (column-attached) → false
    expect(meta.contains(container.querySelector('[data-testid="chat-bubble-menu-button"]')), '«⋯» is there too').toBe(true);
    expect(meta.contains(btn()), 'the mouse twin is NOT in the time line (which is display:none for the first message of a run on a mouse)').toBe(false);
  });

  it('⭐ one click on either twin opens the thread with THIS message', async () => {
    for (const pick of [btn, btnTouch]) {
      const onOpenThread = vi.fn(); const m = message();
      await render({ message: m, onOpenThread });
      await act(async () => { pick()!.click(); });
      expect(onOpenThread).toHaveBeenCalledTimes(1);
      expect(onOpenThread).toHaveBeenCalledWith(m);
    }
  });

  it('⭐ its accessible name says WHOSE message (ko and en) — a list of these is not dozens of the same name; mine says «내 글» / «your message»', async () => {
    await render({ message: message({ sender_name: '검수 에이전트' }) });
    for (const pick of [btn, btnTouch]) expect(pick()!.getAttribute('aria-label')).toBe('검수 에이전트의 글에 답글 달기'); // reverted (a plain «답글 달기») → fails
    await render({ message: message({ sender_name: 'Reviewer' }), locale: 'en' });
    for (const pick of [btn, btnTouch]) expect(pick()!.getAttribute('aria-label')).toBe("Reply to Reviewer's message");
    await render({ isMine: true, message: message({ created_by: 'member-1', sender_type: 'human', sender_name: '민서' }) });
    for (const pick of [btn, btnTouch]) expect(pick()!.getAttribute('aria-label')).toBe('내 글에 답글 달기');
    await render({ isMine: true, locale: 'en', message: message({ created_by: 'member-1', sender_type: 'human', sender_name: 'Minseo' }) });
    for (const pick of [btn, btnTouch]) expect(pick()!.getAttribute('aria-label'), 'not «Reply to You\'s message»').toBe('Reply to your message'); // reverted (the {name} key with «You») → «Reply to You's message'
  });

  it('⭐ neither twin is drawn where no thread can be opened (a reply inside a thread has no onOpenThread)', async () => {
    await render({ onOpenThread: null });
    expect(btn()).toBeNull(); expect(btnTouch()).toBeNull(); // reverted (always drawn) → a dead button
  });

  it('it follows the context menu: a continuation, a deleted message and a message that already has replies all have it', async () => {
    await render({ isGrouped: true });
    expect(btn()).not.toBeNull(); expect(btnTouch()).not.toBeNull();
    await render({ message: message({ deleted_at: '2026-11-10T02:00:00.000Z' }) });
    expect(btn()).not.toBeNull(); expect(btnTouch()).not.toBeNull();
    await render({ message: message({ reply_count: 3 }) });
    expect(btn()).not.toBeNull(); expect(btnTouch()).not.toBeNull(); // next to the «3개의 답글» button, which stays
    expect(container.textContent).toContain(koMessages.chats.replyCount.replace('{count}', '3'));
  });

  it('⭐ the mouse twin: opacity reveal under a fine pointer (row hover or keyboard focus — WCAG 1.4.13), still in the tab order; gone on touch / a device that cannot hover', async () => {
    await render();
    const cls = btn()!.className;
    expect(cls).toMatch(/(^|\s)opacity-100(\s|$)/); // shown by default
    expect(cls).toContain('pointer-fine:opacity-0'); // a mouse: hidden until…
    expect(cls).toContain('pointer-fine:group-hover/bubble:opacity-100'); // …the row is hovered
    expect(cls).toContain('pointer-fine:group-focus-within/bubble:opacity-100'); // …or holds keyboard focus
    expect(cls).toContain('pointer-fine:focus-visible:opacity-100');
    expect(cls).toContain('touch:hidden'); // the touch twin takes over there — the SAME `touch:` variant as «⋯»
    expect(cls, 'opacity-0 only under pointer-fine').not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(btn()!.getAttribute('tabindex'), 'in the tab order (never -1)').not.toBe('-1');
  });

  it('⭐ the touch twin: 44 × 44, shown exactly where «⋯» is shown (the same `touch:` variant), hidden otherwise', async () => {
    await render();
    const cls = btnTouch()!.className; const more = (container.querySelector('[data-testid="chat-bubble-menu-button"]') as HTMLElement).className;
    expect(cls).toContain('h-11'); expect(cls).toContain('w-11'); // reverted (a 28 px size) → fails
    expect(cls).toMatch(/(^|\s)hidden(\s|$)/);
    expect(cls).toContain('touch:inline-flex'); expect(more, '«⋯» uses it too').toContain('touch:inline-flex');
    expect(cls, 'the cluster sits row-local: centred on the time line').toContain('top-1/2');
  });

  it('the mouse twin sits on the OUTER side (right of their bubble, left of mine); the touch twin goes beyond «⋯» on the same side (ml-10 / mr-10: «⋯» takes the first 36 px)', async () => {
    await render({ isMine: false });
    expect(btn()!.className).toContain('left-full'); expect(btn()!.className).not.toContain('right-full');
    expect(btnTouch()!.className).toContain('left-full'); expect(btnTouch()!.className).toContain('ml-10');
    await render({ isMine: true, message: message({ created_by: 'member-1', sender_type: 'human', sender_name: '민서' }) });
    expect(btn()!.className).toContain('right-full'); expect(btn()!.className).not.toContain('left-full');
    expect(btnTouch()!.className).toContain('right-full'); expect(btnTouch()!.className).toContain('mr-10');
  });

  it('⭐ the room the mouse reply button takes is set ONLY where the button is drawn: the column cap (--reply-cap 128 px) and the hover-time offset (--reply-room 36 px); inside a thread (no onOpenThread) neither is set, so a thread bubble keeps its 72% and its 8 px', async () => {
    await render();
    const col = container.querySelector('[data-chat-content]') as HTMLElement; const meta = container.querySelector('[data-testid="bubble-meta-line"]') as HTMLElement;
    expect(col.className).toContain('max-w-[72%]');
    expect(col.className).toContain(`${MOUSE}:max-w-[min(72%,calc(100%_-_var(--reply-cap,0px)))]`);
    expect(col.style.getPropertyValue('--reply-cap')).toBe('128px'); // reverted (no variable) → '' and the cap never applies
    expect(meta.style.getPropertyValue('--reply-room')).toBe('36px');
    await render({ onOpenThread: null });
    const col2 = container.querySelector('[data-chat-content]') as HTMLElement; const meta2 = container.querySelector('[data-testid="bubble-meta-line"]') as HTMLElement;
    expect(col2.style.getPropertyValue('--reply-cap'), 'no reply button in a thread → no cap').toBe(''); // reverted (always set) → '128px'
    expect(meta2.style.getPropertyValue('--reply-room'), 'no reply button in a thread → the old 8 px').toBe('');
  });

  it("the continuation's hover time moved out by the button's width so the two never meet (ml-[var(--reply-room,8px)] / mr-…: 36 px beside the reply button, the old 8 px without it)", async () => {
    await render({ isGrouped: true, isMine: false });
    const meta = container.querySelector('[data-testid="bubble-meta-line"]') as HTMLElement;
    expect(meta.className).toContain(`${MOUSE}:group-hover/bubble:ml-[var(--reply-room,8px)]`); // reverted → ml-2: the time sits under the button
    await render({ isGrouped: true, isMine: true, message: message({ created_by: 'member-1', sender_type: 'human', sender_name: '민서' }) });
    expect((container.querySelector('[data-testid="bubble-meta-line"]') as HTMLElement).className).toContain(`${MOUSE}:group-hover/bubble:mr-[var(--reply-room,8px)]`);
  });
});

describe('story 4887 (codex round 1) — a plain row keeps its touch «⋯» on the same side whoever wrote it', () => {
  it('⭐ my message as a plain row (a thread reply): the «⋯» is at the left like everyone else\'s; as a bubble it stays on the bubble\'s outer (left) side when mine', async () => {
    await render({ isMine: true, plainRow: true });
    const more = container.querySelector('[data-testid="chat-bubble-menu-button"]') as HTMLElement;
    expect(more.className).toContain('left-full');
    expect(more.className).not.toContain('right-full'); // reverted (isMine alone) → right-full: the opposite side from the other rows
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render({ isMine: true });
    expect((container.querySelector('[data-testid="chat-bubble-menu-button"]') as HTMLElement).className).toContain('right-full');
  });
});

describe('story 4887 (codex round 2) — a plain row is left-aligned whoever wrote it: the grouped hover time and the touch menu follow', () => {
  it('⭐ a grouped plain row of mine shows its hover time at the right of the text (left-full) — as a bubble it stays at the left of it (right-full)', async () => {
    await render({ isMine: true, plainRow: true, isGrouped: true });
    const meta = () => container.querySelector('[data-testid="bubble-meta-line"]') as HTMLElement;
    expect(meta().className).toContain('group-hover/bubble:left-full');
    expect(meta().className).not.toContain('group-hover/bubble:right-full'); // reverted (isMine alone) → right-full: the time floats on the wrong side of a left-aligned row
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render({ isMine: true, isGrouped: true });
    expect(meta().className).toContain('group-hover/bubble:right-full');
  });

  it('⭐ the touch «⋯» opens the menu from the button\'s LEFT edge for a plain row of mine (a bubble of mine opens it right-aligned, ending at the button\'s right edge)', async () => {
    const open = async (plainRow: boolean) => {
      await render({ isMine: true, plainRow });
      const more = container.querySelector('[data-testid="chat-bubble-menu-button"]') as HTMLElement;
      more.getBoundingClientRect = () => ({ left: 300, right: 340, top: 10, bottom: 50, width: 40, height: 40, x: 300, y: 10, toJSON() {} }) as DOMRect;
      await act(async () => { more.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      return (document.querySelector('[role="menu"]') as HTMLElement).style.left;
    };
    expect(await open(true)).toBe('300px'); // reverted (isMine alone) → 180px: detached from the button
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    expect(await open(false)).toBe('180px'); // 340 − 160
  });
});
