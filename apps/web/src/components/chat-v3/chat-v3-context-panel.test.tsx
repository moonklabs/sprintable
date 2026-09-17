// @vitest-environment jsdom
//
// story #3972 — 맥락 패널 「관련」(오늘 스냅샷 역조회, BE 0 — needsMe는 부모가 공유
// 캐시로 넘겨준다)·「열린 산출물」(openArtifactId prop 있을 때만 fetch) 단위 테스트.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatV3ContextPanel } from './chat-v3-context-panel';
import type { TodayNeedsMeItem } from '@/components/org-briefing/derive-today';

const fetchMock = vi.fn();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: null }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const needsMeItem: TodayNeedsMeItem = {
  id: 'g1', source: 'gate', state: 'signature',
  workItemType: 'channel_post', workItemId: 'w1', workItemTitle: '발행',
  requestedByName: null, reason: null, createdAt: '2026-09-16T00:00:00Z', conversationId: 'conv-1',
};

describe('ChatV3ContextPanel — 관련(오늘 스냅샷 역조회)', () => {
  it('⭐conversationId가 needsMe[].conversationId와 일치하면 관련 링크가 뜬다', async () => {
    await act(async () => {
      root.render(wrap(<ChatV3ContextPanel conversationId="conv-1" openArtifactId={null} needsMe={[needsMeItem]} />));
    });
    expect(container.querySelector('[data-testid="chat-v3-related-today-link"]')).not.toBeNull();
  });

  it('일치하는 needsMe가 없으면 관련은 빈 상태 문구', async () => {
    await act(async () => {
      root.render(wrap(<ChatV3ContextPanel conversationId="conv-2" openArtifactId={null} needsMe={[needsMeItem]} />));
    });
    expect(container.querySelector('[data-testid="chat-v3-related-today-link"]')).toBeNull();
  });
});
