// @vitest-environment jsdom
//
// story 4887 (UI-4 P4-b · AC3 B3) — an AGENT's message has no bubble: the head line (name · agent tag · time) says who, and the text sits on the page. A person's message — mine or another person's — keeps its bubble: it is the bubble that tells the two kinds apart at a glance (B3: «에이전트 글만 말풍선 없는 평문»).
// jsdom draws no layout, so this pins the decision as the element and classes that carry it; the browser spec `e2e/chat-bubble-plain.4887.layout.spec.ts` measures it with the real Tailwind build.
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

const message = (o: { agent: boolean; by: string }): ChatMessage => ({
  id: 'm1', memo_id: 'conv-1', created_by: o.by, sender_name: o.agent ? '개발 에이전트' : '민서', sender_type: o.agent ? 'agent' : 'human', sender_avatar_url: null, sender_runtime_type: null,
  content: '안녕하세요', attachments: [], created_at: '2026-11-10T01:00:00.000Z',
});
async function render(o: { agent: boolean; mine: boolean; grouped?: boolean }) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatBubble message={message({ agent: o.agent, by: o.mine ? 'member-1' : 'other-1' })} isMine={o.mine} isGrouped={o.grouped ?? false} /></NextIntlClientProvider>);
  });
}
const box = () => container.querySelector('[data-testid="chat-bubble-text"]') as HTMLElement;

describe('ChatBubble — an agent has no bubble, a person keeps theirs (story 4887 · UI-4 P4-b)', () => {
  it('⭐ an AGENT\'s message (not mine) is plain: no fill, no rounded box, no padding box — the text sits on the page', async () => {
    await render({ agent: true, mine: false });
    expect(box().getAttribute('data-bubble')).toBe('plain'); // reverted (every message filled) → 'filled'
    for (const c of ['bg-proof-panel', 'bg-proof-blue-soft', 'rounded-xl', 'px-3.5']) expect(box().className, c).not.toContain(c);
    expect(box().textContent).toContain('안녕하세요'); // the text is still there
  });

  it('⭐ …and its head line still says who: the name, the agent tag, the time (that is all that tells an agent\'s plain text from a person\'s)', async () => {
    await render({ agent: true, mine: false });
    const headline = container.querySelector('[data-chat-meta]') as HTMLElement;
    expect(headline.textContent).toContain('개발 에이전트');
    expect(headline.textContent).toContain(koMessages.chats.agent); // the «에이전트» tag
    expect(headline.querySelector('time')).not.toBeNull();
  });

  it('⭐ another PERSON\'s message keeps its bubble (panel fill · rounded · padded) — the bubble is what marks a person', async () => {
    await render({ agent: false, mine: false });
    expect(box().getAttribute('data-bubble')).toBe('filled');
    expect(box().className).toContain('bg-proof-panel'); // reverted (plain for all but mine) → missing
    expect(box().className).toContain('rounded-xl');
    expect(box().className).toContain('px-3.5');
  });

  it('⭐ MY message keeps its bubble (the blue-soft fill, rounded on the left and bottom, padded)', async () => {
    await render({ agent: false, mine: true });
    expect(box().getAttribute('data-bubble')).toBe('filled');
    expect(box().className).toContain('bg-proof-blue-soft');
    expect(box().className).toContain('rounded-xl');
  });

  it('a message of an agent that is MINE (the viewer is that agent) stays filled — «plain» is for the others\' agents only', async () => {
    await render({ agent: true, mine: true });
    expect(box().getAttribute('data-bubble')).toBe('filled');
    expect(box().className).toContain('bg-proof-blue-soft');
  });

  it('a CONTINUATION of an agent\'s run is plain too (no head, still no bubble)', async () => {
    await render({ agent: true, mine: false, grouped: true });
    expect(box().getAttribute('data-bubble')).toBe('plain');
    expect(container.querySelector('[data-testid="bubble-head-time"]')).toBeNull();
  });
});
