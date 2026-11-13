// @vitest-environment jsdom
//
// story 4912 (C2a) — the detail's «연결 설정» card: on the DetailCard (ds Card) with ds buttons (the hosted / local choice says which is on), the ds Skeleton while loading and the ds Textarea for the manual-copy fallback. No behaviour change.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentConnectionSettingsSection } from './agent-connection-settings-section';
import { HighlightedJson } from '@/app/onboarding/connect-step';

const { copied, clip } = vi.hoisted(() => ({ copied: [] as string[], clip: { ok: true } }));
vi.mock('@/lib/clipboard', () => ({ copyTextSafely: async (text: string) => { copied.push(text); return { ok: clip.ok }; } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STDIO = JSON.stringify({ mcpServers: { 'sprintable-mcp': { type: 'stdio', command: 'uvx', env: { SPRINTABLE_API_KEY: '<YOUR_AGENT_API_KEY>' } } } });
const HTTP = JSON.stringify({ mcpServers: { 'sprintable-mcp': { type: 'http', url: 'https://example.test/mcp' } } });
const urls: string[] = [];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { copied.length = 0; clip.ok = true; urls.length = 0; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });
const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });

function stub(mode: 'ok' | 'error' | 'hosted-400' = 'ok') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(String(url));
    if (mode === 'error') return new Response('{}', { status: 500 });
    if (mode === 'hosted-400' && String(url).includes('transport=http')) return new Response('{}', { status: 400 });
    return new Response(JSON.stringify({ data: { files: [{ filename: '.mcp.json', content: String(url).includes('transport=http') ? HTTP : STDIO }, { filename: 'AGENTS.md', content: '# 안내' }] } }), { status: 200 });
  }));
}
async function mount(freshApiKey: string | null = null) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentConnectionSettingsSection agentId="agent-1" freshApiKey={freshApiKey} /></NextIntlClientProvider>); });
}
const O = koMessages.onboarding;
const card = () => container.querySelector('[data-testid="agent-detail-card-connection"]') as HTMLElement;
const choice = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find((b) => b.textContent?.includes(label))!;
const btn = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);

describe('AgentConnectionSettingsSection — ds 한 층(story 4912 · C2a)', () => {
  it('⭐카드는 DetailCard(ds Card · bg-ds-surface) — 옛 SectionCard가 아니다 · 제목 · 설명 · .mcp.json · 다른 파일 칸', async () => {
    stub();
    await mount();
    await settle();
    expect(card().getAttribute('data-slot')).toBe('ds-card');
    expect(card().className).toContain('bg-ds-surface');
    expect(card().textContent).toContain(koMessages.settings.agentMcpTitle);
    expect(card().textContent).toContain('.mcp.json');
    expect(card().textContent).toContain('AGENTS.md');
  });

  it('⭐호스팅 / 로컬 고르기는 ds 단추 둘이고 켜진 쪽을 aria-pressed로 말한다(읽은 설정이 stdio면 «로컬») — 누르면 그 전송으로 다시 읽고 켜진 쪽이 바뀐다', async () => {
    stub();
    await mount();
    await settle();
    expect(choice(O.transportLocal).getAttribute('aria-pressed')).toBe('true');
    expect(choice(O.transportHosted).getAttribute('aria-pressed')).toBe('false');
    await act(async () => { choice(O.transportHosted).click(); });
    await settle();
    expect(urls.some((u) => u.includes('connection-artifact?transport=http'))).toBe(true);
    expect(choice(O.transportHosted).getAttribute('aria-pressed')).toBe('true');
    expect(choice(O.transportLocal).getAttribute('aria-pressed')).toBe('false');
  });

  it('호스팅을 못 쓰는 응답(400)이어도 이미 읽어 둔 설정은 그대로 보이고 실패 줄은 뜨지 않는다(«호스팅 불가»는 읽은 파일이 없을 때만)', async () => {
    stub('hosted-400');
    await mount();
    await settle();
    await act(async () => { choice(O.transportHosted).click(); });
    await settle();
    expect(card().textContent).toContain('.mcp.json');
    expect(card().textContent).not.toContain(koMessages.settings.agentMcpLoadError);
    expect(choice(O.transportHosted).getAttribute('aria-pressed')).toBe('true');
  });

  it('⭐읽는 동안은 ds Skeleton(손으로 그린 animate-pulse 아님) · 읽기 실패는 실패 줄', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async () => { await gate; return new Response('{}', { status: 500 }); }));
    await mount();
    expect(card().querySelector('[data-slot="ds-skeleton"]')).not.toBeNull();
    expect(card().innerHTML).not.toContain('animate-pulse');
    await act(async () => { release(); });
    await settle();
    expect(card().textContent).toContain(koMessages.settings.agentMcpLoadError);
    expect(card().querySelector('[data-slot="ds-skeleton"]')).toBeNull();
  });

  it('복사 성공: 단추가 «복사됨»으로 바뀌고 클립보드엔 지금 보이는 설정이 간다(실패 줄 없음)', async () => {
    stub();
    await mount();
    await settle();
    await act(async () => { btn(O.copyConfig)?.click(); });
    await settle();
    expect(copied.at(-1)).toBe(STDIO);
    expect(btn(O.copied)).toBeTruthy();
    expect(card().querySelector('[role="alert"]')).toBeNull();
  });

  it('복사 실패: «직접 선택해 복사» 줄 + (새 키가 있으면) 실 config가 든 ds Textarea', async () => {
    stub();
    await mount('sk_live_FULL');
    await settle();
    clip.ok = false;
    await act(async () => { btn(O.copyConfig)?.click(); });
    await settle();
    expect(copied.at(-1)).toContain('sk_live_FULL'); // the clipboard text carries the real key
    expect(card().querySelector('[role="alert"]')?.textContent).toContain(koMessages.common.copyFailedSelectManually);
    const ta = card().querySelector('textarea[data-testid="agent-connection-settings-copy-failed-raw-config"]') as HTMLTextAreaElement;
    expect(ta.getAttribute('data-slot')).toBe('ds-textarea');
    expect(ta.value).toContain('sk_live_FULL');
  });
});

describe('agent-connection-settings-section.tsx — 소스', () => {
  const src = readFileSync(join(__dirname, 'agent-connection-settings-section.tsx'), 'utf8');
  it('⭐옛 ui/ 부품 · 맨 <button> · 손으로 그린 animate-pulse · 옛 글자 토큰이 없다 — 되돌리면 RED', () => {
    expect([...src.matchAll(/from '@\/components\/ui\/([\w-]+)'/g)].map((m) => m[1])).toEqual([]);
    expect(src).not.toMatch(/<button[\s>]/);
    expect(src).not.toContain('animate-pulse');
    expect(src).not.toMatch(/text-(muted-foreground|foreground|destructive|xs|sm|base)\b/);
    expect(src).toContain('<DetailCard');
  });
});

describe('HighlightedJson — 글자색은 ds 토큰(눌린 면 위 4.5:1 · story 4912 · C2a codex)', () => {
  it('⭐키 · 문자열 · 부호가 ds 토큰이고 옛 text-success / text-muted-foreground / text-primary가 아니다', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    const r = createRoot(host);
    await act(async () => { r.render(<pre><HighlightedJson text={'{"a": "b"}'} /></pre>); });
    const cls = [...host.querySelectorAll('span')].map((e) => e.className).filter(Boolean);
    expect(cls).toEqual(expect.arrayContaining(['text-ds-action-text', 'text-ds-info', 'text-ds-ink-3']));
    expect(cls.join(' ')).not.toMatch(/text-(success|muted-foreground|primary)\b/);
    await act(async () => { r.unmount(); }); host.remove();
  });
});

