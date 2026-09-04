// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { isSandboxChannelDraft, SandboxTestBadge } from './sandbox-test-badge';

describe('isSandboxChannelDraft(story f30da19a AC5)', () => {
  it('channel==="sandbox"만 true, 그 외(threads·null·undefined)는 false', () => {
    expect(isSandboxChannelDraft('sandbox')).toBe(true);
    expect(isSandboxChannelDraft('threads')).toBe(false);
    expect(isSandboxChannelDraft(null)).toBe(false);
    expect(isSandboxChannelDraft(undefined)).toBe(false);
  });
});

describe('SandboxTestBadge — 색이 아니라 글자로 전달(유나 확定 ②)', () => {
  it('⭐텍스트 「테스트」를 렌더한다', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
          <SandboxTestBadge />
        </NextIntlClientProvider>,
      );
    });
    const badge = container.querySelector('[data-testid="channel-post-sandbox-test-badge"]');
    expect(badge?.textContent).toBe(koMessages.content.channelPostsSandboxTestBadge);
    await act(async () => { root.unmount(); });
    container.remove();
  });
});
