// @vitest-environment jsdom
//
// story 4912 (B1) — the API key screen: one ROW per agent saying what its keys are (how many active · last used · expiring within 7 days — or that the READ failed, which is not «no key»),
// and the «키 관리» panel holding the key manager for ONE agent at a time (Enter / double click / the button / the menu all open it; closing re-reads the rows).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import ApiKeysPage, { summarizeKeys } from './page';

vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
const { managerProps } = vi.hoisted(() => ({ managerProps: { current: [] as Array<{ agentId: string; compact?: boolean }> } }));
vi.mock('@/components/agents/agent-api-key-manager', () => ({
  AgentApiKeyManager: (props: { agentId: string; compact?: boolean }) => { managerProps.current.push(props); return <div data-testid="stub-agent-api-key-manager" data-agent-id={props.agentId} />; },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const keyReads: string[] = [];
beforeEach(() => { managerProps.current = []; keyReads.length = 0; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

const DAY = 24 * 3600 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
function stub(keysByAgent: Record<string, unknown[] | 'fail'>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/team-members?')) {
      return new Response(JSON.stringify({ data: ['a1', 'a2', 'a3'].map((id) => ({ id, name: `에이전트 ${id}`, type: 'agent', is_active: true, runtime_type: 'claude-code' })) }), { status: 200 });
    }
    const m = url.match(/^\/api\/agents\/(a\d)\/api-key$/);
    if (m) {
      keyReads.push(m[1]!);
      const v = keysByAgent[m[1]!];
      return v === 'fail' ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ data: v ?? [] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }));
}
const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
async function mount() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ApiKeysPage /></NextIntlClientProvider>); });
  await settle();
}
const row = (id: string) => container.querySelector(`[data-testid="api-key-row-${id}"]`)!;
const sub = (id: string) => row(id).querySelector('[data-slot="ds-list-row"] .font-mono')?.textContent ?? '';
const S = koMessages.settings;

describe('summarizeKeys — 한 줄이 말하는 것', () => {
  it('활성만 센다 · 마지막 사용은 활성 키 중 가장 최근 · 7일 이내 만료만 «임박»(이미 만료된 키 · 먼 만료는 아님)', () => {
    const now = Date.now();
    const r = summarizeKeys([
      { id: 'k1', last_used_at: '2026-11-01T00:00:00Z', revoked_at: null, expires_at: new Date(now + 3 * DAY).toISOString() },
      { id: 'k2', last_used_at: '2026-11-10T00:00:00Z', revoked_at: null, expires_at: new Date(now + 30 * DAY).toISOString() },
      { id: 'k3', last_used_at: '2026-11-12T00:00:00Z', revoked_at: '2026-11-12T01:00:00Z', expires_at: null }, // revoked: neither counted nor «last used»
      { id: 'k4', last_used_at: null, revoked_at: null, expires_at: new Date(now - DAY).toISOString() }, // already expired: not «expiring»
    ], now);
    expect(r.active).toBe(3);
    expect(r.lastUsedAt).toBe('2026-11-10T00:00:00Z');
    expect(r.expiresInDays).toBe(3);
  });
});

describe('API 키 화면 줄(story 4912 · B1)', () => {
  it('⭐줄 셋: 활성 키 수 · 마지막 사용 · «⚠ n일 안에 만료» · 키 없음 · 읽기 실패는 «없음»이 아니라 «키를 읽지 못했어요»', async () => {
    stub({
      a1: [{ id: 'k1', key_prefix: 'sk_a', created_at: '2026-08-01T00:00:00Z', last_used_at: iso(-2 * 3600 * 1000), revoked_at: null, expires_at: iso(3 * DAY) }],
      a2: [],
      a3: 'fail',
    });
    await mount();
    expect(sub('a1')).toContain(S.agentApiKeyRowActive.replace('{count}', '1'));
    expect(sub('a1')).toContain('⚠');
    expect(sub('a1')).toContain(S.agentApiKeyRowExpiring.replace('{days}', '3'));
    expect(sub('a2')).toBe(S.agentApiKeyRowNone);
    expect(sub('a3')).toBe(S.agentApiKeyRowReadFailed);
    expect(sub('a3')).not.toBe(S.agentApiKeyRowNone); // a failed read is not an empty list
  });

  it('⭐줄 하나가 «키 관리»로 패널을 연다 — 단추 · Enter · 더블클릭 · 우클릭 메뉴 모두 같은 일 · 패널엔 키 관리자가 compact로 한 에이전트만', async () => {
    stub({});
    await mount();
    expect(document.querySelector('[data-testid="api-key-panel"]')).toBeNull();
    await act(async () => { (row('a2').querySelector('button:not([data-slot="ds-row-actions-trigger"])') as HTMLElement).click(); });
    await settle();
    expect(document.querySelector('[data-testid="api-key-panel"]')).not.toBeNull();
    expect(managerProps.current.at(-1)).toMatchObject({ agentId: 'a2', compact: true });
    expect(document.querySelectorAll('[data-testid="stub-agent-api-key-manager"]')).toHaveLength(1); // ONE agent at a time
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle();
    expect(document.querySelector('[data-testid="api-key-panel"]')).toBeNull();
    // Enter on the row, then double click on another row
    const main = (id: string) => row(id).querySelector('[data-row-main]') as HTMLElement;
    main('a1').focus();
    await act(async () => { main('a1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle();
    expect(managerProps.current.at(-1)).toMatchObject({ agentId: 'a1' });
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle();
    await act(async () => { main('a3').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
    await settle();
    expect(managerProps.current.at(-1)).toMatchObject({ agentId: 'a3' });
  });

  it('⭐패널을 닫으면 줄의 키 요약을 다시 읽는다(무효화 · 재발급이 줄에 보인다) — 열기만 해서는 다시 읽지 않는다', async () => {
    stub({ a1: [] });
    await mount();
    const initial = keyReads.filter((x) => x === 'a1').length;
    expect(initial).toBe(1);
    await act(async () => { (row('a1').querySelector('button:not([data-slot="ds-row-actions-trigger"])') as HTMLElement).click(); });
    await settle();
    expect(keyReads.filter((x) => x === 'a1').length).toBe(1); // opened: no re-read yet (the stub manager reads nothing)
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle();
    expect(keyReads.filter((x) => x === 'a1').length).toBe(2); // closed: the row read again
  });
});
