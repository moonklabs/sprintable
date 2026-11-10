// @vitest-environment jsdom
//
// story 4887 (UI-4 P4-a) — where a message's time is drawn: once per run, in the head line beside the name; a continuation keeps its time for screen readers and shows it on hover beside the bubble (where a mouse can hover);
// a touch screen keeps the line under each bubble. jsdom draws no layout, so these pin the decisions as the elements and classes that carry them; the browser spec `e2e/chat-bubble-time-run.4887.layout.spec.ts` measures them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ChatBubble } from './chat-bubble';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';

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

const message = (created_by = 'agent-1'): ChatMessage => ({
  id: 'm1', memo_id: 'conv-1', created_by, sender_name: '개발 에이전트', sender_type: 'agent', sender_avatar_url: null, sender_runtime_type: null,
  content: '안녕하세요', attachments: [], created_at: '2026-11-10T01:00:00.000Z',
});
async function render(o: { isGrouped: boolean; isMine: boolean }) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatBubble message={message(o.isMine ? 'member-1' : 'agent-1')} isMine={o.isMine} isGrouped={o.isGrouped} /></NextIntlClientProvider>);
  });
}
const head = () => container.querySelector('[data-testid="bubble-head-time"]') as HTMLElement | null;
const meta = () => container.querySelector('[data-testid="bubble-meta-line"]') as HTMLElement;
const MOUSE = '[@media(pointer:fine)_and_(hover:hover)]';

describe('ChatBubble — the time of a run (story 4887 · UI-4 P4-a)', () => {
  it('⭐ the FIRST message of a run carries the time in its head — shown where a mouse can hover, hidden on touch (the touch line under the bubble stays)', async () => {
    await render({ isGrouped: false, isMine: false });
    expect(head(), 'the head time exists').not.toBeNull(); // reverted (no head time) → null
    expect(head()!.className).toContain('hidden'); // not drawn by default …
    expect(head()!.className).toContain(`${MOUSE}:inline`); // … and drawn where a mouse can hover
    expect(head()!.getAttribute('datetime')).toBe('2026-11-10T01:00:00.000Z');
  });

  it('⭐ …and its time line under the bubble is gone where a mouse can hover — and only there (touch keeps it: the «⋯» button sits on it)', async () => {
    await render({ isGrouped: false, isMine: false });
    expect(meta().className).toContain(`${MOUSE}:hidden`); // reverted → the line stays for mice too
    expect(meta().className).not.toContain('sr-only');
    expect(meta().querySelector('[data-testid="chat-bubble-menu-button"]')).not.toBeNull(); // the touch button is still on the cell
  });

  it('⭐ a CONTINUATION has no head (no name · no head time) — its time stays in the tree for screen readers and shows beside the bubble while the row is hovered', async () => {
    await render({ isGrouped: true, isMine: false });
    expect(head(), 'no head time on a continuation').toBeNull();
    expect(meta().querySelector('time')!.textContent).not.toBe(''); // a screen reader still has its time (sr-only, not display:none)
    const cls = meta().className;
    expect(cls).toContain(`${MOUSE}:sr-only`); // reverted (hidden) → a screen reader loses the time
    expect(cls).toContain(`${MOUSE}:group-hover/bubble:not-sr-only`);
    expect(cls).toContain(`${MOUSE}:group-hover/bubble:absolute`);
    expect(cls).not.toContain(`${MOUSE}:hidden`);
  });

  it('⭐ the hover time sits on the OUTER side: right of their bubble, left of mine', async () => {
    await render({ isGrouped: true, isMine: false });
    expect(meta().className).toContain(`${MOUSE}:group-hover/bubble:left-full`);
    expect(meta().className).not.toContain(`${MOUSE}:group-hover/bubble:right-full`);
    await render({ isGrouped: true, isMine: true });
    expect(meta().className).toContain(`${MOUSE}:sr-only`); // my continuation is read by screen readers too
    expect(meta().className).not.toContain(`${MOUSE}:hidden`);
    expect(meta().className).toContain(`${MOUSE}:group-hover/bubble:right-full`); // reverted (same side for both) → fails one of the two
    expect(meta().className).not.toContain(`${MOUSE}:group-hover/bubble:left-full`);
  });

  it('⭐ what hover reveals, keyboard focus reveals too (WCAG 1.4.13): the continuation\'s time is shown beside the bubble while the row holds focus — on both sides', async () => {
    for (const mine of [false, true]) {
      await render({ isGrouped: true, isMine: mine });
      const cls = meta().className;
      expect(cls).toContain(`${MOUSE}:group-focus-within/bubble:not-sr-only`); // reverted → the time shows on hover only
      expect(cls).toContain(`${MOUSE}:group-focus-within/bubble:absolute`);
      expect(cls).toContain(`${MOUSE}:group-focus-within/bubble:${mine ? 'right-full' : 'left-full'}`);
    }
  });

  it('the row is the hover group and the column anchors the hover time', async () => {
    await render({ isGrouped: true, isMine: false });
    expect(container.querySelector('.group\\/bubble')).not.toBeNull();
    expect((container.querySelector('[data-chat-content]') as HTMLElement).className).toContain('relative');
  });
});
