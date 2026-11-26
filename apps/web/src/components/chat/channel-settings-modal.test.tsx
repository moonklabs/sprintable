// @vitest-environment jsdom
//
// story 5032 (C2) — the channel settings window: «이 채널의 모든 말 받기 — 에이전트마다». One switch per agent of the channel = that agent's own delivery level for THIS room (`all` on · `mentions` off) through the existing
// notification-preferences API with `member_id`; owner / admin only (the server's rule); the token note shows when a switch is on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ChannelSettingsModal, type ChannelAgent } from './channel-settings-modal';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONV = 'conv-ch-1';
const A: ChannelAgent = { member_id: 'ag-1', name: '개발', runtime_type: 'claude-code' };
const B: ChannelAgent = { member_id: 'ag-2', name: '디자인', runtime_type: 'codex' };

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const pref = (level: 'all' | 'mentions' | 'mute') => ({ scope_type: 'conversation', scope_id: CONV, channel: 'sse', level });
function stub(prefs: Record<string, ReturnType<typeof pref>[]>, putOk = true, putStatus = 200) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return { ok: putOk, status: putStatus, json: async () => (putOk ? { data: {} } : { error: { message: 'Agent cannot do that' } }) };
    const memberId = new URL(url, 'http://x').searchParams.get('member_id') ?? '';
    return { ok: true, status: 200, json: async () => ({ data: prefs[memberId] ?? [] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function mount(agents: ChannelAgent[], canEdit = true, onOpenMy = () => {}, roomFreeResponse = false) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChannelSettingsModal conversationId={CONV} agents={agents} canEditAgents={canEdit} roomFreeResponse={roomFreeResponse} onClose={() => {}} onOpenMyNotifications={onOpenMy} />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const rows = () => [...document.querySelectorAll('[data-testid="channel-receive-all-row"]')] as HTMLElement[];
const switchOf = (row: HTMLElement) => row.querySelector('[data-slot="switch"]') as HTMLElement;

describe('ChannelSettingsModal (story 5032)', () => {
  it('⭐ one switch per agent, read from that agent\'s OWN level for this room (all = on · mentions / none = off)', async () => {
    stub({ 'ag-1': [pref('all')], 'ag-2': [pref('mentions')] });
    await mount([A, B]);
    expect(rows().map((r) => r.getAttribute('data-agent-id'))).toEqual(['ag-1', 'ag-2']);
    expect(switchOf(rows()[0]!).getAttribute('aria-checked')).toBe('true');
    expect(switchOf(rows()[1]!).getAttribute('aria-checked')).toBe('false');
    // the reads ask for the agent (member_id), never the person's own level
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('/api/notification-preferences?member_id=ag-1');
    expect(urls).toContain('/api/notification-preferences?member_id=ag-2');
  });

  it('⭐ turning a switch on saves level `all` for THAT agent in THIS room and shows the token note («사용량이 늘 수 있어요»); off saves `mentions`', async () => {
    stub({});
    await mount([A, B]);
    await act(async () => { switchOf(rows()[0]!).click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')!;
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({
      preferences: [{ scope_type: 'conversation', scope_id: CONV, channel: 'sse', level: 'all' }],
      member_id: 'ag-1',
    });
    expect(rows()[0]!.querySelector('[data-testid="channel-receive-all-token-note"]')?.textContent).toBe('이 에이전트가 이 채널의 모든 말을 읽어요 — 사용량이 늘 수 있어요.');
    expect(rows()[1]!.querySelector('[data-testid="channel-receive-all-token-note"]')).toBeNull(); // the other agent is untouched
    await act(async () => { switchOf(rows()[0]!).click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    const puts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
    expect(JSON.parse((puts[1]![1] as RequestInit).body as string).preferences[0].level).toBe('mentions');
    expect(rows()[0]!.querySelector('[data-testid="channel-receive-all-token-note"]')).toBeNull();
  });

  it('⭐ a refused save puts the switch back and says why (the server\'s own sentence for a 4xx)', async () => {
    stub({}, false, 400);
    await mount([A]);
    await act(async () => { switchOf(rows()[0]!).click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(switchOf(rows()[0]!).getAttribute('aria-checked')).toBe('false');
    expect(rows()[0]!.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('⭐ not an owner / admin → no per-agent switches and no reads of other members\' levels, only the «관리자만» line', async () => {
    stub({});
    await mount([A, B], false);
    expect(rows()).toHaveLength(0);
    expect(document.querySelector('[data-testid="channel-receive-all-admin-only"]')).not.toBeNull();
    expect(fetchMock.mock.calls.length).toBe(0); // reverted → reads another member's level (a 403)
  });

  it('a channel with no agent says so; «내 알림 설정» opens the room\'s own delivery window', async () => {
    stub({});
    let opened = 0;
    await mount([], true, () => { opened += 1; });
    expect(document.querySelector('[data-testid="channel-receive-all-empty"]')).not.toBeNull();
    await act(async () => { (document.querySelector('[data-testid="channel-open-my-notifications"]') as HTMLButtonElement).click(); });
    expect(opened).toBe(1);
  });
});

describe('ChannelSettingsModal — codex round 1 (story 5032)', () => {
  it('⭐ the room-wide «receive every word» switch is ON → every agent shows on, locked, with the line that says why (a per-agent off would not take effect)', async () => {
    stub({ 'ag-1': [pref('mentions')] });
    await mount([A, B], true, () => {}, true);
    expect(document.querySelector('[data-testid="channel-receive-all-room-wide"]')).not.toBeNull(); // reverted → an «off» that does nothing
    for (const r of rows()) {
      expect(switchOf(r).getAttribute('aria-checked')).toBe('true');
      expect(switchOf(r).hasAttribute('data-disabled') || switchOf(r).getAttribute('aria-disabled') === 'true' || (switchOf(r) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('⭐ a FAILED read is not «off»: the row stays locked and says it could not be read', async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 403, json: async () => null }));
    vi.stubGlobal('fetch', fetchMock);
    await mount([A]);
    const row = rows()[0]!;
    expect(row.querySelector('[role="alert"]')?.textContent).toBe('설정을 불러오지 못했어요.');
    expect(switchOf(row).hasAttribute('data-disabled') || switchOf(row).getAttribute('aria-disabled') === 'true' || (switchOf(row) as HTMLButtonElement).disabled).toBe(true);
  });

  it('⭐ a parent that hands over a NEW agents array on every render does not make the window read again', async () => {
    stub({});
    const make = () => [{ ...A }, { ...B }];
    const view = (agents: ChannelAgent[]) => (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChannelSettingsModal conversationId={CONV} agents={agents} canEditAgents onClose={() => {}} onOpenMyNotifications={() => {}} />
      </NextIntlClientProvider>
    );
    await act(async () => { root.render(view(make())); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const reads = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== 'PUT').length;
    const before = reads();
    expect(before).toBe(2);
    await act(async () => { root.render(view(make())); });
    await act(async () => { root.render(view(make())); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(reads()).toBe(before); // reverted (the effect depending on the array) → 6 reads
  });

  it('a saved switch keeps the value the person chose (the save, not an older read, has the last word)', async () => {
    stub({});
    await mount([A]);
    await act(async () => { switchOf(rows()[0]!).click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(switchOf(rows()[0]!).getAttribute('aria-checked')).toBe('true');
  });
});

describe('ChannelSettingsModal — codex round 2 (story 5032): a read that began before a save never has the last word', () => {
  it('⭐ the agents list changes (a new read of A begins), THEN the person saves A, THEN the older read lands — late value or late failure: A keeps what was saved and is not locked', async () => {
    const pending: Array<{ id: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    let firstRound = true;
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: {} }) });
      const id = new URL(url, 'http://x').searchParams.get('member_id') ?? '';
      if (firstRound) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
      return new Promise((resolve, reject) => { pending.push({ id, resolve, reject }); });
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = (agents: ChannelAgent[]) => (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChannelSettingsModal conversationId={CONV} agents={agents} canEditAgents onClose={() => {}} onOpenMyNotifications={() => {}} />
      </NextIntlClientProvider>
    );
    await act(async () => { root.render(view([A])); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    firstRound = false;
    await act(async () => { root.render(view([A, B])); }); // the list changed → A and B are read again (both pending)
    for (let i = 0; i < 2; i++) await act(async () => { await Promise.resolve(); });
    const aRead = pending.find((p) => p.id === 'ag-1')!;
    expect(aRead, 'a second read of A is pending').toBeTruthy();
    await act(async () => { switchOf(rows().find((r) => r.getAttribute('data-agent-id') === 'ag-1')!).click(); }); // save A → on
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const rowA = () => rows().find((r) => r.getAttribute('data-agent-id') === 'ag-1')!;
    expect(switchOf(rowA()).getAttribute('aria-checked')).toBe('true');
    aRead.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) }); // the OLDER read lands late, saying «off»
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(switchOf(rowA()).getAttribute('aria-checked')).toBe('true'); // reverted (no counter) → flips back to off
    // and a late FAILURE of an older read does not lock the saved row either
    await act(async () => { root.render(view([A, B, { member_id: 'ag-3', name: '검수' }])); });
    for (let i = 0; i < 2; i++) await act(async () => { await Promise.resolve(); });
    const aRead2 = pending.filter((p) => p.id === 'ag-1').at(-1)!;
    await act(async () => { switchOf(rowA()).click(); }); // save A → off
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    aRead2.reject(new Error('late failure'));
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(rowA().querySelector('[role="alert"]')).toBeNull();
    const sw = switchOf(rowA());
    expect(sw.hasAttribute('data-disabled') || sw.getAttribute('aria-disabled') === 'true' || (sw as HTMLButtonElement).disabled === true, 'A is not locked').toBe(false);
  });
});
