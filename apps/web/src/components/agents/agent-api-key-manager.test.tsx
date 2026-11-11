// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentApiKeyManager } from './agent-api-key-manager';

// story #4359(까디르 4740) — 실패 toast는 늘 ko 키(원인 영어 Error 메시지는 로그로만) → toast를 손에 쥔다.
const { addToast, toastHolder } = vi.hoisted(() => { const f = vi.fn(); return { addToast: f, toastHolder: { current: f } }; });
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: toastHolder.current }) }));

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
  toastHolder.current = addToast;
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// story 4889 — 402폭 가로 넘침(CI layout e2e `mobile-width-overflow` · 실측 스크롤러 scrollWidth 487 > 402): 카드 머리가 «제목 | 버튼 셋(333px 한 줄)»이라 좁은 폭에서 버튼 줄이 카드 밖으로 밀렸다.
// jsdom은 폭을 못 재므로 wrap/shrink 계약을 DOM 클래스로 고정한다(실제 폭은 e2e `402폭 — API 키 화면`이 잰다).
describe('AgentApiKeyManager — 4889 header does not push the card wider at 402', () => {
  it('⭐머리는 줄바꿈을 허용하고(flex-wrap) 제목 칸은 줄어들 수 있고(min-w-0) 버튼 묶음도 줄바꿈 · 줄어든다 — 되돌리면 빨강', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages}>
          <AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const card = document.querySelector('[data-testid="agent-api-key-manager"]');
    expect(card).toBeTruthy();
    const head = card!.querySelector('h3')!.parentElement!.parentElement!; // 제목 칸의 부모 = 머리 줄
    expect(head.className).toContain('flex-wrap');
    expect(head.firstElementChild!.className).toContain('min-w-0');
    const actions = head.lastElementChild!; // 버튼 묶음 칸
    expect(actions.className).toContain('min-w-0');
    const buttonRow = actions.firstElementChild!; // 버튼 셋의 줄
    expect(buttonRow.className).toContain('flex-wrap');
    expect(buttonRow.querySelectorAll('button').length).toBe(3);
  });
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

    const select = document.querySelector('select[data-slot="select"]') as HTMLSelectElement | null;
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

    const select = document.querySelector('select[data-slot="select"]') as HTMLSelectElement;
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

describe('AgentApiKeyManager — story 4889 (AC3 §5-8): a failed read says so with [다시 시도] (it was a toast and then «키가 없어요»)', () => {
  const mount = async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages}>
          <AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  };
  const failed = () => document.querySelector('[data-testid="agent-api-key-load-failed"]');
  it('⭐a failed read: the failure line + [다시 시도] are there and «키가 없어요» is NOT (a failed read is not an empty list) — and the retry reads again, then shows the keys', async () => {
    let ok = false;
    const fetchMock = vi.fn(async (url: string) => (!String(url).endsWith('/api-key') ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : ok ? new Response(JSON.stringify({ data: [apiKeyFixture(['read'])] }), { status: 200 }) : new Response('{}', { status: 500 })));
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    expect(failed()).toBeTruthy();
    expect(failed()!.textContent).toContain(koMessages.settings.agentApiKeyLoadFailed);
    expect(document.body.textContent).not.toContain(koMessages.settings.agentApiKeyEmpty);
    const retry = Array.from(failed()!.querySelectorAll('button')).find((b) => b.textContent === '다시 시도')!;
    expect(retry).toBeTruthy();
    ok = true;
    retry.focus();
    await act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(failed()).toBeNull();
    expect(document.body.textContent).toContain('sk_live_abcd1234');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('agent-api-key-refresh'); // the retry button is gone — the focus did not fall to the page
  });
  it('a read that works: no failure line, and an empty list still says «키가 없어요»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await mount();
    expect(failed()).toBeNull();
    expect(document.body.textContent).toContain(koMessages.settings.agentApiKeyEmpty);
  });
  it('a refresh that fails after keys were shown keeps the keys and adds the failure line above them', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (!String(url).endsWith('/api-key') ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : n++ === 0 ? new Response(JSON.stringify({ data: [apiKeyFixture(['read'])] }), { status: 200 }) : new Response('{}', { status: 500 }))));
    await mount();
    expect(failed()).toBeNull();
    const refresh = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.agentApiKeyRefresh)!;
    await act(async () => { refresh.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(failed()).toBeTruthy();
    expect(document.body.textContent).toContain('sk_live_abcd1234');
  });
});

describe('AgentApiKeyManager — story 4889: only the latest read writes (a late older answer must not overwrite a newer one)', () => {
  const render = (agentId: string) => root.render(
    <NextIntlClientProvider locale="ko" messages={koMessages}>
      <AgentApiKeyManager agentId={agentId} agentName="테스트 에이전트" />
    </NextIntlClientProvider>,
  );
  it('⭐another agent: an earlier agent\'s read that FAILS late does not put the failure line over this agent\'s keys', async () => {
    const pending: Array<{ resolve: (r: Response) => void; url: string }> = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>((resolve) => { if (String(url).endsWith('/api-key')) pending.push({ resolve, url }); else resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })); })));
    await act(async () => { render('agent-1'); });
    await act(async () => { render('agent-2'); });
    await act(async () => { pending[pending.length - 1]!.resolve(new Response(JSON.stringify({ data: [apiKeyFixture(['read'])] }), { status: 200 })); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { pending[0]!.resolve(new Response('{}', { status: 500 })); await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="agent-api-key-load-failed"]')).toBeNull();
    expect(document.body.textContent).toContain('sk_live_abcd1234');
    expect((document.querySelector('[data-testid="agent-api-key-refresh"]') as HTMLButtonElement).disabled).toBe(false); // (the late answer did not touch `loading` either)
  });
  it('⭐another agent: the earlier agent\'s keys do not stay, and the earlier agent\'s late answer does not land on this one', async () => {
    const pending: Array<{ resolve: (r: Response) => void; url: string }> = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>((resolve) => { if (String(url).endsWith('/api-key')) pending.push({ resolve, url }); else resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })); })));
    await act(async () => { render('agent-1'); });
    await act(async () => { render('agent-2'); });
    const urls = pending.map((p) => p.url);
    expect(urls[0]).toContain('agent-1');
    expect(urls[urls.length - 1]).toContain('agent-2');
    await act(async () => { pending[pending.length - 1]!.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { pending[0]!.resolve(new Response(JSON.stringify({ data: [apiKeyFixture(['read'])] }), { status: 200 })); await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).not.toContain('sk_live_abcd1234');
    expect(document.body.textContent).toContain(koMessages.settings.agentApiKeyEmpty);
  });
});

describe('AgentApiKeyManager — story 4889: the rest of the read bookkeeping', () => {
  const render = (agentId: string) => root.render(
    <NextIntlClientProvider locale="ko" messages={koMessages}>
      <AgentApiKeyManager agentId={agentId} agentName="테스트 에이전트" />
    </NextIntlClientProvider>,
  );
  const keyReads = () => {
    const pending: Array<{ resolve: (r: Response) => void; url: string }> = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>((resolve) => { if (String(url).endsWith('/api-key')) pending.push({ resolve, url }); else resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })); })));
    return pending;
  };
  const refreshOff = () => (document.querySelector('[data-testid="agent-api-key-refresh"]') as HTMLButtonElement).disabled;
  const answer = async (p: { resolve: (r: Response) => void }, r: Response) => { await act(async () => { p.resolve(r); await Promise.resolve(); await Promise.resolve(); }); };
  const KEYS = () => new Response(JSON.stringify({ data: [apiKeyFixture(['read'])] }), { status: 200 });
  it('⭐an older read answering while the newer one is still out does not turn the loading state off (the refresh stays off until the newer read ends)', async () => {
    const pending = keyReads();
    await act(async () => { render('agent-1'); });
    await act(async () => { render('agent-2'); });
    expect(refreshOff()).toBe(true);
    await answer(pending[0]!, KEYS()); // the OLDER one answers first
    expect(refreshOff()).toBe(true);
    expect(document.body.textContent).not.toContain('sk_live_abcd1234'); // and its keys are not this agent's
    await answer(pending[pending.length - 1]!, new Response(JSON.stringify({ data: [] }), { status: 200 }));
    expect(refreshOff()).toBe(false);
  });
  it('⭐switching agents drops the earlier agent\'s keys at once (they do not stay while the new agent\'s read is out)', async () => {
    const pending = keyReads();
    await act(async () => { render('agent-1'); });
    await answer(pending[0]!, KEYS());
    expect(document.body.textContent).toContain('sk_live_abcd1234');
    await act(async () => { render('agent-2'); });
    expect(document.body.textContent).not.toContain('sk_live_abcd1234');
  });
  it('⭐an agent that goes away (no id) cancels the read still out — its late answer lands nowhere', async () => {
    const pending = keyReads();
    await act(async () => { render('agent-1'); });
    await act(async () => { render(''); });
    await answer(pending[0]!, KEYS());
    expect(document.body.textContent).not.toContain('sk_live_abcd1234');
  });
  it('⭐a retry that fails again keeps the focus on [다시 시도] (it moves to [새로고침] only once the read worked)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('/api-key') ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ data: [] }), { status: 200 }))));
    await act(async () => { render('agent-1'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const retry = document.querySelector('[data-testid="agent-api-key-load-failed"] button') as HTMLButtonElement;
    retry.focus();
    await act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="agent-api-key-load-failed"]')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('다시 시도');
  });
});

describe('AgentApiKeyManager — story 4889: a late callback of an EARLIER agent (generate / revoke still out) and several cards on one page', () => {
  const render = (agentId: string) => root.render(
    <NextIntlClientProvider locale="ko" messages={koMessages}>
      <AgentApiKeyManager agentId={agentId} agentName="테스트 에이전트" />
    </NextIntlClientProvider>,
  );
  it('⭐a revoke of the earlier agent that ends after the switch does not reload the earlier agent\'s keys into this one nor clear this one\'s loading', async () => {
    const readers: Array<{ resolve: (r: Response) => void; url: string }> = [];
    let revokeDone: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
      const u = String(url);
      if (init?.method === 'DELETE') { revokeDone = resolve; return; }
      if (u.endsWith('/api-key')) readers.push({ resolve, url: u });
      else resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    })));
    await act(async () => { render('agent-1'); });
    await act(async () => { readers[0]!.resolve(new Response(JSON.stringify({ data: [apiKeyFixture(['read'])] }), { status: 200 })); await Promise.resolve(); await Promise.resolve(); });
    // press «무효화» on agent-1's key (opens a confirm → confirm) — simpler: call through the revoke button path
    const revokeBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.agentApiKeySingleRevokeConfirmCta);
    expect(revokeBtn).toBeTruthy();
    await act(async () => { revokeBtn!.click(); await Promise.resolve(); });
    const confirm = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent === koMessages.settings.agentApiKeySingleRevokeConfirmCta).pop()!;
    await act(async () => { confirm.click(); await Promise.resolve(); });
    await act(async () => { render('agent-2'); });
    await act(async () => { revokeDone(new Response('{}', { status: 200 })); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    // the earlier agent's card is gone: its reload (if it still asks) answers nowhere
    for (const r of readers.slice(1).filter((x) => x.url.includes('agent-1'))) await act(async () => { r.resolve(new Response(JSON.stringify({ data: [apiKeyFixture(['read'])] }), { status: 200 })); await Promise.resolve(); await Promise.resolve(); });
    expect((document.querySelector('[data-testid="agent-api-key-refresh"]') as HTMLButtonElement).disabled).toBe(true); // agent-2's read is still out — the late callback did not clear it
    expect(document.body.textContent).not.toContain('sk_live_abcd1234');
  });
  it('⭐an agent that goes away while its read is out leaves no stuck loading state (the refresh is not left off)', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>((resolve) => { if (!String(url).endsWith('/api-key')) resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })); })));
    await act(async () => { render('agent-1'); });
    expect((document.querySelector('[data-testid="agent-api-key-refresh"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { render(''); });
    expect((document.querySelector('[data-testid="agent-api-key-refresh"]') as HTMLButtonElement).disabled).toBe(false);
  });
  it('⭐two cards on one page: the retry of the SECOND card focuses its own [새로고침] (not the first card\'s)', async () => {
    let ok = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (!String(url).endsWith('/api-key') ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : ok ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : new Response('{}', { status: 500 }))));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages}>
          <AgentApiKeyManager agentId="agent-1" agentName="첫째" />
          <AgentApiKeyManager agentId="agent-2" agentName="둘째" />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const cards = Array.from(document.querySelectorAll('[data-testid="agent-api-key-manager"]'));
    expect(cards).toHaveLength(2);
    ok = true;
    const retry2 = cards[1]!.querySelector('[data-testid="agent-api-key-load-failed"] button') as HTMLButtonElement;
    retry2.focus();
    await act(async () => { retry2.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const refresh2 = cards[1]!.querySelector('[data-testid="agent-api-key-refresh"]');
    expect(document.activeElement).toBe(refresh2);
  });
});

describe('AgentApiKeyManager — story 4889: reads of ONE card that overlap (the load effect re-runs) — only the latest writes', () => {
  const render = () => root.render(
    <NextIntlClientProvider locale="ko" messages={koMessages}>
      <AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" />
    </NextIntlClientProvider>,
  );
  const overlap = async () => {
    const pending: Array<{ resolve: (r: Response) => void }> = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>((resolve) => { if (String(url).endsWith('/api-key')) pending.push({ resolve }); else resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })); })));
    await act(async () => { render(); });
    toastHolder.current = vi.fn(); // a new toast function = a new loader = the load effect runs again while the first read is still out
    await act(async () => { render(); });
    expect(pending).toHaveLength(2);
    return pending;
  };
  const settle = async (p: { resolve: (r: Response) => void }, r: Response) => { await act(async () => { p.resolve(r); await Promise.resolve(); await Promise.resolve(); }); };
  it('⭐the older read answers LAST with a failure → no failure line over the newer read\'s keys', async () => {
    const pending = await overlap();
    await settle(pending[1]!, new Response(JSON.stringify({ data: [apiKeyFixture(['read'])] }), { status: 200 }));
    await settle(pending[0]!, new Response('{}', { status: 500 }));
    expect(document.querySelector('[data-testid="agent-api-key-load-failed"]')).toBeNull();
    expect(document.body.textContent).toContain('sk_live_abcd1234');
  });
  it('⭐the older read answers LAST with keys → they do not overwrite the newer read\'s empty list; and the older read does not turn loading off while the newer is out', async () => {
    const pending = await overlap();
    await settle(pending[0]!, new Response(JSON.stringify({ data: [apiKeyFixture(['read'])] }), { status: 200 }));
    expect((document.querySelector('[data-testid="agent-api-key-refresh"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain('sk_live_abcd1234');
    await settle(pending[1]!, new Response(JSON.stringify({ data: [] }), { status: 200 }));
    expect((document.querySelector('[data-testid="agent-api-key-refresh"]') as HTMLButtonElement).disabled).toBe(false);
    expect(document.body.textContent).toContain(koMessages.settings.agentApiKeyEmpty);
  });
});

describe('AgentApiKeyManager — story 4889: what a gone card still has in flight does not reach the page', () => {
  it('⭐a generate of agent-1 that ends AFTER the switch to agent-2 neither calls onNewKey (its plaintext key) nor toasts', async () => {
    const onNewKey = vi.fn();
    let postDone: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
      if (String(url).includes('/api-key') && init?.method === 'POST') { postDone = resolve; return; }
      resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    })));
    const render = (id: string) => root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages}>
        <AgentApiKeyManager agentId={id} agentName="테스트 에이전트" onNewKey={onNewKey} />
      </NextIntlClientProvider>,
    );
    await act(async () => { render('agent-1'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const generateBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.agentApiKeyGenerate);
    await act(async () => { generateBtn?.click(); await Promise.resolve(); });
    await act(async () => { render('agent-2'); });
    addToast.mockClear();
    await act(async () => { postDone(new Response(JSON.stringify({ data: { api_key: 'sk_live_AGENT1_SECRET' } }), { status: 201 })); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(onNewKey).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('sk_live_AGENT1_SECRET');
    expect(addToast).not.toHaveBeenCalled();
  });
  it('⭐a generate of agent-1 that FAILS after the switch to agent-2 does not toast the failure on the other agent\'s page', async () => {
    let postDone: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
      if (String(url).includes('/api-key') && init?.method === 'POST') { postDone = resolve; return; }
      resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    })));
    const render = (id: string) => root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages}>
        <AgentApiKeyManager agentId={id} agentName="테스트 에이전트" />
      </NextIntlClientProvider>,
    );
    await act(async () => { render('agent-1'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const generateBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.agentApiKeyGenerate);
    await act(async () => { generateBtn?.click(); await Promise.resolve(); });
    await act(async () => { render('agent-2'); });
    addToast.mockClear();
    await act(async () => { postDone(new Response('{}', { status: 500 })); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(addToast).not.toHaveBeenCalled();
  });
  it('a generate that ends while its card is still there calls onNewKey (the normal path is unchanged)', async () => {
    const onNewKey = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (String(url).includes('/api-key') && init?.method === 'POST'
      ? new Response(JSON.stringify({ data: { api_key: 'sk_live_new' } }), { status: 201 })
      : new Response(JSON.stringify({ data: [] }), { status: 200 }))));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages}>
          <AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" onNewKey={onNewKey} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const generateBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.agentApiKeyGenerate);
    await act(async () => { generateBtn?.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(onNewKey).toHaveBeenCalledWith('sk_live_new', null);
  });
});
