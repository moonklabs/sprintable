// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentApiKeyManager } from './agent-api-key-manager';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const LONG_SCOPES = ['read', 'write', 'admin', 'stories', 'tasks', 'epics', 'sprints', 'memos', 'notifications', 'standups'];

function apiKeyFixture(scope: string[]) {
  return {
    id: 'key-1',
    key_prefix: 'sk_live_abcd1234',
    created_at: '2026-08-01T00:00:00Z',
    last_used_at: null,
    revoked_at: null,
    expires_at: null,
    scope,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// story #2526 — scope 개수가 늘면 권한 칩이 카드/화면 밖으로 overflow 되던 결함.
// jsdom은 실제 overflow를 계산하지 않으므로, wrap/shrink 계약(flex-wrap·min-w-0·max-width)이
// DOM 클래스로 고정돼 있는지를 검증한다. 실제 시각 회귀는 라이브 QA 몫.
describe('AgentApiKeyManager — #2526 scope chip overflow', () => {
  it('scope 다수(10개)일 때도 칩 행이 flex-wrap으로 감싸진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api-key')) {
        return new Response(JSON.stringify({ data: [apiKeyFixture(LONG_SCOPES)] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }));

    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages}>
          <AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const adminChip = Array.from(document.querySelectorAll('span')).find((s) => s.textContent === 'admin');
    expect(adminChip).toBeTruthy();
    const chipRow = adminChip?.parentElement;
    expect(chipRow?.className).toContain('flex-wrap');

    const cardRow = chipRow?.closest('div.border.rounded-md');
    const leftCol = chipRow?.closest('div.min-w-0');
    expect(leftCol).toBeTruthy();
    expect(leftCol?.className).toContain('flex-1');
    expect(cardRow?.className).toContain('flex-wrap');
  });

  it('scope 텍스트가 길어도 칩 자체는 max-w-full + truncate로 잘린다(카드 밖 삐져나가지 않음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api-key')) {
        return new Response(JSON.stringify({ data: [apiKeyFixture(['a-very-long-scope-group-key-name-that-could-overflow'])] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }));

    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages}>
          <AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const chip = Array.from(document.querySelectorAll('span'))
      .find((s) => s.textContent === 'a-very-long-scope-group-key-name-that-could-overflow');
    expect(chip).toBeTruthy();
    expect(chip?.className).toContain('truncate');
    expect(chip?.className).toContain('max-w-full');
    expect(chip?.getAttribute('title')).toBe('a-very-long-scope-group-key-name-that-could-overflow');
  });

  it('scope 짧은(기존) 케이스도 회귀 없이 렌더된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api-key')) {
        return new Response(JSON.stringify({ data: [apiKeyFixture(['read', 'write'])] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }));

    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages}>
          <AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(Array.from(document.querySelectorAll('span')).some((s) => s.textContent === 'read')).toBe(true);
    expect(Array.from(document.querySelectorAll('span')).some((s) => s.textContent === 'write')).toBe(true);
  });
});
