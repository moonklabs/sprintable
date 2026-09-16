// @vitest-environment jsdom
//
// story #3972 — 맥락 패널 「관련」(오늘 스냅샷 역조회, BE 0)·「열린 산출물」
// (openArtifactId prop 있을 때만 fetch) 단위 테스트.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatV3ContextPanel } from './chat-v3-context-panel';

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
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('ChatV3ContextPanel — 관련(오늘 스냅샷 역조회)', () => {
  it('⭐conversationId가 needs_me[].conversation_id와 일치하면 관련 링크가 뜬다', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/today') {
        return {
          ok: true, status: 200, json: async () => ({
            data: {
              needs_me: [{
                source: 'gate', source_id: 'g1', kind: 'approval', risk: 'low',
                work_item: { id: 'w1', type: 'channel_post', title: '발행' },
                requested_by: null, reason: null, created_at: '2026-09-16T00:00:00Z',
                conversation_id: 'conv-1',
              }],
              needs_me_count: 1, agent_progress: [], published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } },
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    });
    await act(async () => {
      root.render(wrap(<ChatV3ContextPanel conversationId="conv-1" openArtifactId={null} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="chat-v3-related-today-link"]')).not.toBeNull();
  });

  it('일치하는 needs_me가 없으면 관련은 빈 상태 문구', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: null }) });
    await act(async () => {
      root.render(wrap(<ChatV3ContextPanel conversationId="conv-2" openArtifactId={null} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="chat-v3-related-today-link"]')).toBeNull();
  });
});
