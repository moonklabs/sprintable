// @vitest-environment jsdom
//
// story 5048 T0 ②c — 말풍선 모양(키트): 안쪽 12/16 · 모서리 16 + 꼬리(말한 쪽 위 모서리) 4 · 최대 폭 480. 실 DOM.
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
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src?: string; alt?: string }) => <img src={src} alt={alt} />,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const message = (senderType: 'human' | 'agent'): ChatMessage => ({
  id: 'm5048s', memo_id: 'conv-1', created_by: senderType === 'human' ? 'member-1' : 'agent-1', sender_name: 'N', sender_type: senderType, sender_avatar_url: null, sender_runtime_type: null,
  content: '안녕하세요', attachments: [], created_at: '2026-11-26T00:00:00.000Z',
});

async function bubble(isMine: boolean, senderType: 'human' | 'agent' = 'human'): Promise<{ b: HTMLElement; col: HTMLElement }> {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatBubble message={message(senderType)} isMine={isMine} />
      </NextIntlClientProvider>,
    );
  });
  const b = container.querySelector('[data-testid="chat-bubble-text"]') as HTMLElement;
  return { b, col: container.querySelector('[data-chat-content]') as HTMLElement };
}

describe('말풍선 모양 (story 5048 T0 ②c)', () => {
  it('⭐내 말풍선: 모서리 12 · 오른쪽 위 꼬리 4 · 안쪽 14/10(채팅 밀도 11-27: 16 → 12 · 16/12 → 14/10)', async () => {
    const { b } = await bubble(true);
    const c = b.className.split(/\s+/);
    expect(c).toEqual(expect.arrayContaining(['rounded-ds-bubble', 'rounded-tr-ds-tail', 'px-3.5', 'py-2.5']));
    expect(c).not.toContain('rounded-tl-ds-tail');
  });
  it('⭐남의 말풍선: 모서리 12 · 왼쪽 위 꼬리 4 · 안쪽 14/10(채팅 밀도 11-27)', async () => {
    const { b } = await bubble(false);
    const c = b.className.split(/\s+/);
    expect(c).toEqual(expect.arrayContaining(['rounded-ds-bubble', 'rounded-tl-ds-tail', 'px-3.5', 'py-2.5']));
    expect(c).not.toContain('rounded-tr-ds-tail');
  });
  it('⭐최대 폭은 72%와 480 중 작은 쪽(--container-ds-bubble)', async () => {
    const { col } = await bubble(false);
    expect(col.className).toContain('max-w-[min(72%,var(--container-ds-bubble))]');
    expect(col.className).toContain('var(--container-ds-bubble),calc(100%_-_var(--reply-cap,0px))');
  });
});
