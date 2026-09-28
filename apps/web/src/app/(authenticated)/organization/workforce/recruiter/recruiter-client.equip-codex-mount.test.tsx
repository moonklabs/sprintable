// @vitest-environment jsdom
//
// story #4180 CHANGES(카디르 QA·PO 재확認) — equip-skip(«역할 없이·키만») 폼도 같은
// renderRuntimePicker를 렌더해(#2433 B) Codex를 고를 수 있는데, 결과 카드 본문·복사가
// JSON(.mcp.json) 하드코딩으로 남아 있었다. 실 마운트로 Codex 선택 → 생성 → 결과 카드가
// config.toml(TOML)·경로 안내를 렌더하고 복사도 TOML인지, claude-code는 기존 JSON 그대로인지 고정.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { parse } from 'smol-toml';
import { RecruiterClient } from './recruiter-client';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars ? `${ns}.${key}(${JSON.stringify(vars)})` : `${ns}.${key}`;
    t.rich = (key: string) => `${ns}.${key}`;
    t.markup = (key: string) => `${ns}.${key}`;
    t.raw = (key: string) => `${ns}.${key}`;
    t.has = () => true;
    return t;
  },
  useLocale: () => 'ko',
}));

vi.mock('@/app/onboarding/onboarding-telemetry', () => ({
  emitOnboardingEvent: vi.fn(),
  beaconOnboardingEvent: vi.fn(),
}));

const copyMock = vi.fn(async (_text: string) => ({ ok: true as const }));
vi.mock('@/lib/clipboard', () => ({
  copyTextSafely: (text: string) => copyMock(text),
}));

const MCP_CONFIG = {
  mcpServers: {
    'sprintable-mcp': {
      type: 'stdio',
      command: 'uvx',
      args: ['sprintable'],
      env: { SPRINTABLE_API_URL: 'https://backend.example.run.app', AGENT_GATEWAY_V2: '1', AGENT_API_KEY: 'sk_test_equip' },
    },
  },
};

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

function buttonsWithText(container: HTMLElement, match: (text: string) => boolean): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((b) => match(b.textContent ?? ''));
}

async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

async function runEquipFlow(container: HTMLElement, pickRuntime: string | null) {
  const skip = buttonsWithText(container, (t) => t.includes('recruiter.equipSkipCardTitle'));
  expect(skip.length).toBe(1);
  await click(skip[0]);
  const next = buttonsWithText(container, (t) => t === 'recruiter.next');
  await click(next[0]);
  await flush();

  if (pickRuntime) {
    const rt = buttonsWithText(container, (t) => t.endsWith(pickRuntime));
    expect(rt.length).toBe(1);
    await click(rt[0]);
  }

  const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(nameInput, 'Equip Codex Agent');
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const create = buttonsWithText(container, (t) => t === 'recruiter.equipCreateCta');
  expect(create.length).toBe(1);
  await click(create[0]);
  await flush();
}

function equipCard(container: HTMLElement): HTMLElement {
  const label = Array.from(container.querySelectorAll('p')).find((p) =>
    (p.textContent ?? '').includes('recruiter.equipMcpConfigLabel'),
  );
  expect(label).toBeTruthy();
  return label!.parentElement!.parentElement as HTMLElement;
}

describe('RecruiterClient equip-skip — Codex면 결과 카드·복사가 config.toml(TOML) (story #4180)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    copyMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') return jsonResponse({ data: [] });
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: [] });
      if (url === '/api/agents' && method === 'POST') {
        return jsonResponse({ data: { id: 'agent-eq', mcp_config: MCP_CONFIG, api_key: 'sk_test_equip' } });
      }
      if (url === '/api/team-members/agent-eq' && method === 'PATCH') return jsonResponse({ data: {} });
      throw new Error(`unmocked fetch: ${method} ${url}`);
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => {
      root = createRoot(container);
      root.render(<RecruiterClient projectId="proj-1" showTopBar={false} />);
    });
    await flush();
  }

  it('Codex 선택 → 카드 라벨 config.toml·경로 안내·본문이 파싱되는 TOML, 복사도 같은 TOML', async () => {
    await mount();
    await runEquipFlow(container, 'Codex');

    const card = equipCard(container);
    expect(card.textContent).toContain('config.toml');
    expect(card.textContent).toContain('recruiter.codexConfigTomlPathNote');
    expect(card.textContent).toContain('"path":".codex/config.toml"');
    expect(card.textContent).not.toContain('globalPath');
    const pre = card.querySelector('pre')!;
    expect(pre.textContent).toContain('[mcp_servers.sprintable-mcp]');
    expect(pre.textContent).not.toContain('mcpServers');
    const parsed = parse(pre.textContent ?? '') as { mcp_servers: { 'sprintable-mcp': { command: string } } };
    expect(parsed.mcp_servers['sprintable-mcp'].command).toBe('uvx');

    const copyBtn = buttonsWithText(card, (t) => t === 'recruiter.copy');
    expect(copyBtn.length).toBe(1);
    await click(copyBtn[0]);
    expect(copyMock).toHaveBeenCalledTimes(1);
    expect(copyMock.mock.calls[0][0]).toBe(pre.textContent);
  });

  it('음성대조 — 기본 claude-code는 .mcp.json 라벨·JSON 본문·JSON 복사 그대로(무회귀)', async () => {
    await mount();
    await runEquipFlow(container, null);

    const card = equipCard(container);
    expect(card.textContent).toContain('.mcp.json');
    expect(card.textContent).not.toContain('recruiter.codexConfigTomlPathNote');
    const pre = card.querySelector('pre')!;
    expect(pre.textContent).toBe(JSON.stringify(MCP_CONFIG, null, 2));

    const copyBtn = buttonsWithText(card, (t) => t === 'recruiter.copy');
    await click(copyBtn[0]);
    expect(copyMock.mock.calls[0][0]).toBe(JSON.stringify(MCP_CONFIG, null, 2));
  });
});
