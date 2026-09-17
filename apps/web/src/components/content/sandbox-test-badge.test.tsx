// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { isSandboxChannelDraft, SandboxTestBadge } from './sandbox-test-badge';

describe('isSandboxChannelDraft(story f30da19a AC5·#4009 AC5)', () => {
  it('channel==="sandbox"만 true, 그 외(threads·null·undefined)는 false', () => {
    expect(isSandboxChannelDraft('sandbox')).toBe(true);
    expect(isSandboxChannelDraft('threads')).toBe(false);
    expect(isSandboxChannelDraft(null)).toBe(false);
    expect(isSandboxChannelDraft(undefined)).toBe(false);
  });

  // story #4009(critical) — 이전엔 'sandbox' 한 키만 봐서 instagram_sandbox 등
  // 7개가 배지를 못 받았다(channel_adapters.py의 is_test_channel=True 8개 전부와
  // 대조). 실 채널·실계정과 혼동되면 안 되므로 접미 일치가 정확해야 한다.
  it('⭐8개 테스트용 채널 전부 true(_sandbox 접미 관례)', () => {
    for (const ch of [
      'sandbox', 'instagram_sandbox', 'facebook_sandbox', 'ads_sandbox',
      'x_sandbox', 'youtube_sandbox', 'stibee_sandbox', 'ghost_sandbox',
    ]) {
      expect(isSandboxChannelDraft(ch)).toBe(true);
    }
  });

  it('실 채널(sandbox 접미 없음)은 전부 false', () => {
    for (const ch of ['threads', 'instagram', 'facebook', 'meta_ads', 'x', 'youtube', 'stibee', 'ghost', 'wordpress', 'webhook', 'hosted_site']) {
      expect(isSandboxChannelDraft(ch)).toBe(false);
    }
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
