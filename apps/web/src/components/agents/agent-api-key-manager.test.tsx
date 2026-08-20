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

// story #2838 — 발급 UI에 만료 선택이 아예 없어 90일이 몰래 각인되던 결함(유나 세션 침묵
// 실사고). 이제 발급자가 항상 화면에서 선택하고, 그 선택이 POST body의 expires_at으로
// 그대로 전송돼야 한다(서버가 이 필드를 필수로 강제하는 것과 짝 — api_key.py 참고).
describe('AgentApiKeyManager — #2838 발급 시 만료 명시 전송', () => {
  it('만료 선택 UI가 화면에 렌더되고 기본값(90일)이 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api-key')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
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

    const select = document.querySelector('select') as HTMLSelectElement | null;
    expect(select).toBeTruthy();
    expect(select?.value).toBe('90d');
    const options = Array.from(select?.options ?? []).map((o) => o.value);
    expect(options).toEqual(['30d', '90d', '180d', '365d', 'never']);
  });

  it('발급 클릭 시 POST body에 expires_at이 명시(기본 90일 → 미래 ISO 날짜)로 실린다', async () => {
    let capturedBody: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api-key') && init?.method === 'POST') {
        capturedBody = init.body as string;
        return new Response(JSON.stringify({ data: { api_key: 'sk_live_new' } }), { status: 201 });
      }
      if (url.includes('/api-key')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
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

    const generateBtn = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent === 'Generate API Key');
    expect(generateBtn).toBeTruthy();
    await act(async () => { generateBtn?.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(capturedBody).toBeTruthy();
    const parsed = JSON.parse(capturedBody as unknown as string) as { expires_at?: string | null };
    expect(parsed.expires_at).toBeTruthy();
    expect(new Date(parsed.expires_at as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('«만료 없음» 선택 시 POST body의 expires_at이 명시적 null로 전송된다(90일 폴백 금지)', async () => {
    let capturedBody: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api-key') && init?.method === 'POST') {
        capturedBody = init.body as string;
        return new Response(JSON.stringify({ data: { api_key: 'sk_live_new' } }), { status: 201 });
      }
      if (url.includes('/api-key')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
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

    const select = document.querySelector('select') as HTMLSelectElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(select, 'never');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const generateBtn = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent === 'Generate API Key');
    await act(async () => { generateBtn?.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(capturedBody).toBeTruthy();
    const parsed = JSON.parse(capturedBody as unknown as string) as { expires_at?: string | null };
    expect('expires_at' in parsed).toBe(true);
    expect(parsed.expires_at).toBeNull();
  });
});
