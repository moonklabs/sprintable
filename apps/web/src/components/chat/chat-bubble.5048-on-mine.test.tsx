// @vitest-environment jsdom
//
// story 5048 T0 ① — the «couldn't copy» notice of an inline code span sits on the BUBBLE face, not inside the light code chip: on an own message (dark face) it must be on-mine ink,
// not text-destructive (red on black / on white fails 4.5:1). Real DOM, the clipboard refuses.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ChatBubble, INLINE_CODE_COPY_DELAY_MS } from './chat-bubble';
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

const message = (content: string): ChatMessage => ({
  id: 'm5048', memo_id: 'conv-1', created_by: 'member-1', sender_name: 'Me', sender_type: 'human', sender_avatar_url: null, sender_runtime_type: null,
  content, attachments: [], created_at: '2026-11-26T00:00:00.000Z',
});

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('refused')) } });
  document.execCommand = vi.fn().mockReturnValue(false);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function failCopy(isMine: boolean): Promise<HTMLElement> {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatBubble message={message('run `pnpm build` now')} isMine={isMine} />
      </NextIntlClientProvider>,
    );
  });
  const code = container.querySelector('code[role="button"]') as HTMLElement;
  await act(async () => { code.click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(INLINE_CODE_COPY_DELAY_MS + 50); });
  return container.querySelector('[role="alert"]') as HTMLElement;
}

describe('copy-failure notice on the own face (story 5048 T0 ①)', () => {
  it('own message: the notice is on-mine ink, not red', async () => {
    const notice = await failCopy(true);
    expect(notice, 'the refused copy shows the notice').not.toBeNull();
    expect(notice.className).toContain('text-ds-on-mine');
    expect(notice.className).not.toContain('text-destructive');
  });
  it("someone else's message keeps the red notice", async () => {
    const notice = await failCopy(false);
    expect(notice).not.toBeNull();
    expect(notice.className).toContain('text-destructive');
  });
});
