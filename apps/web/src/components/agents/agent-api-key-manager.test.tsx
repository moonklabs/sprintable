// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentApiKeyManager } from './agent-api-key-manager';

// story #4359(까디르 4740) — 실패 toast는 늘 ko 키(원인 영어 Error 메시지는 로그로만) → toast를 손에 쥔다.
const addToast = vi.fn();
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast }) }));

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
      .find((b) => b.textContent === koMessages.settings.agentApiKeyGenerate); // story #4359 — ko 문구
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
      .find((b) => b.textContent === koMessages.settings.agentApiKeyGenerate); // story #4359 — ko 문구
    await act(async () => { generateBtn?.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(capturedBody).toBeTruthy();
    const parsed = JSON.parse(capturedBody as unknown as string) as { expires_at?: string | null };
    expect('expires_at' in parsed).toBe(true);
    expect(parsed.expires_at).toBeNull();
  });
});

// [SID:4311 PR 3] 머리 줄은 목록 라벨(같은 이름 둘이면 «· ID 앞 8자») · 없으면 agentName 그대로.
describe('AgentApiKeyManager — 머리 줄 라벨([SID:4311 PR 3])', () => {
  it('agentLabel이 오면 머리 줄에 그 라벨 · 안 오면 agentName', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages}>
          <AgentApiKeyManager agentId="aaaa1111-1" agentName="봇" agentLabel="봇 · aaaa1111" />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('h3')?.textContent).toBe(koMessages.settings.agentApiKeyListTitle.replace('{name}', '봇 · aaaa1111')); // story #4359 — ko 머리 줄
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages}>
          <AgentApiKeyManager agentId="aaaa1111-1" agentName="봇" />
        </NextIntlClientProvider>,
      );
    });
    expect(document.querySelector('h3')?.textContent).toBe(koMessages.settings.agentApiKeyListTitle.replace('{name}', '봇')); // story #4359 — ko 머리 줄
  });
});


// story #4359(까디르 4740 ①②) — 이 파일에 남아 있던 보이는 영어: 실패 toast가 영어 `error.message`를 그대로 보여 줌 ·
// 목록 줄(마지막 사용 · 무효화 · 만료 · N일 뒤 만료) · 생성 창 복사 버튼 — 모두 ko 키로.
describe('AgentApiKeyManager — 보이는 영어 0(story #4359)', () => {
  async function render(keys: unknown[] | null) {
    addToast.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => (keys === null
      ? new Response('boom', { status: 500 })
      : new Response(JSON.stringify({ data: keys }), { status: 200 }))));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('⭐불러오기 실패 toast 본문 = ko 키(영어 «Failed to load API keys» 아님) · 원인은 로그로', async () => {
    await render(null);
    const errorToast = addToast.mock.calls.map((c) => c[0] as { type: string; body: string }).find((x) => x.type === 'error');
    expect(errorToast?.body).toBe(koMessages.settings.agentApiKeyLoadFailed);
    expect(console.error).toHaveBeenCalled();
  });

  it('⭐목록 줄 — 마지막 사용 · 무효화 · 만료 날짜가 ko 문구 · 영어 낱말 0', async () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await render([
      { ...apiKeyFixture(['read']), id: 'k1', last_used_at: past, expires_at: soon },
      { ...apiKeyFixture(['read']), id: 'k2', revoked_at: past },
      { ...apiKeyFixture(['read']), id: 'k3', expires_at: later },
      { ...apiKeyFixture(['read']), id: 'k4', expires_at: past },
    ]);
    const text = container.textContent ?? '';
    expect(text).toContain('마지막 사용');
    expect(text).toContain('무효화');
    expect(text).toMatch(/3일 뒤 만료/);
    expect(text).toContain('만료 ');
    expect(text).toContain('만료됨');
    expect(text).not.toMatch(/Last used|Revoked|Expire/);
  });
});
