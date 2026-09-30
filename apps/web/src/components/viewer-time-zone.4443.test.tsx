// @vitest-environment jsdom
//
// story #4443 — one screen, one time zone: the viewer's. Kadir's second line: «연결된 기기» said «9월 30일» (next-intl had no
// zone, so the server's UTC) while the chat beside it said «오전 07:32» (the browser's). Live RED on dev c1eae9842, 2026-09-30
// 22:39Z, a browser in Asia/Seoul: five device rows disconnected between 22:09Z and 22:32Z read «9월 30일» (KST: 10월 1일).
// Every case here pins its zones (the runtime's own is mocked) — this Mac runs in KST and CI in UTC.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../messages/ko.json';
import { ViewerTimeZoneProvider } from './viewer-time-zone';
import { dayKeyIn, validTimeZone } from '@/lib/viewer-time-zone';
import type { ChatV3MessagesHandle } from './chat-v3/chat-v3-messages';

const { runtimeTz, useDashboardContextMock } = vi.hoisted(() => ({ runtimeTz: { value: 'Asia/Seoul' as string | null }, useDashboardContextMock: vi.fn() }));
vi.mock('@/lib/viewer-time-zone', async (orig) => ({ ...(await orig<typeof import('@/lib/viewer-time-zone')>()), runtimeTimeZone: () => runtimeTz.value }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/today', useRouter: () => ({ push: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

/** What a person can read: the page's text without the held (invisible) places. */
function visibleText(el: Element): string {
  const c = el.cloneNode(true) as Element;
  c.querySelectorAll('[data-testid="viewer-tz-pending"]').forEach((n) => n.remove());
  return c.textContent ?? '';
}

// next-intl as the server hands it down today (no zone set → UTC); the viewer's zone comes only from ViewerTimeZoneProvider
function page(node: React.ReactNode, serverTimeZone: string | null) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
      <ViewerTimeZoneProvider serverTimeZone={serverTimeZone}>{node}</ViewerTimeZoneProvider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  runtimeTz.value = 'Asia/Seoul';
  document.cookie = 'tz=; max-age=0; path=/';
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('[SID:4443] the viewer\'s zone — the rule', () => {
  it('only a real IANA zone passes (canonical name) · anything else is null', () => {
    expect(validTimeZone('Asia/Seoul')).toBe('Asia/Seoul');
    expect(validTimeZone('America/Argentina/Buenos_Aires')).not.toBeNull(); // three parts pass the shape (ICU may give its canonical alias)
    expect(validTimeZone('UTC')).toBe('UTC');
    for (const bad of ['', 'Asia/Nowhere', 'Asia/Seoul; path=/', '../etc', 'a'.repeat(65), 42, null, undefined]) expect(validTimeZone(bad)).toBeNull();
  });

  it('a day is the viewer\'s day: 22:18Z on 9/30 is 10/1 in Seoul, 9/30 in UTC and Los Angeles', () => {
    expect(dayKeyIn('2026-09-30T22:18:00Z', 'Asia/Seoul')).toBe('2026-10-01');
    expect(dayKeyIn('2026-09-30T22:18:00Z', 'UTC')).toBe('2026-09-30');
    expect(dayKeyIn('2026-09-30T22:18:00Z', 'America/Los_Angeles')).toBe('2026-09-30');
  });
});

describe('[SID:4443] «연결된 기기» — the live RED', () => {
  const setups = [{
    setup_id: '11111111-1111-4111-8111-111111111111', device_name: 'qa-live-4433', state: 'disconnected',
    confirmed_at: '2026-09-30T22:14:11Z', confirmed_by_name: '친절 오호', revoked_at: '2026-09-30T22:32:01Z', revoked_by_name: '친절 오호',
    active_keys: 0, members: [{ kind: 'agent', member_id: 'agent-1' }],
  }];
  async function mount(serverTimeZone: string | null) {
    useDashboardContextMock.mockReturnValue({ orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgName: 'QA', orgSlug: 'qa', role: 'owner' }], projectMemberships: [], userName: '친절 오호' });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ setups }), { status: 200 }));
    const { DesktopDevices } = await import('./desktop/desktop-devices');
    await act(async () => { root.render(page(<DesktopDevices />, serverTimeZone)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('a viewer in Seoul reads the disconnect at 22:32Z as «10월 1일» — next-intl alone said «9월 30일»', async () => {
    await mount('Asia/Seoul');
    const meta = container.querySelector('[data-testid="desktop-device-meta"]')!;
    expect(visibleText(meta)).toContain('10월 1일 연결 끊음');
    expect(meta.textContent).not.toContain('9월 30일');
  });

  it('a viewer in Los Angeles reads the same moment as «9월 30일» (their day, not Seoul\'s)', async () => {
    runtimeTz.value = 'America/Los_Angeles';
    await mount('America/Los_Angeles');
    expect(visibleText(container.querySelector('[data-testid="desktop-device-meta"]')!)).toContain('9월 30일 연결 끊음');
  });

  it('the zone not known yet: the date\'s place is held invisible — no date can be read, not even a UTC one', async () => {
    runtimeTz.value = null; // a page that cannot tell its zone stays held
    await mount(null);
    const meta = container.querySelector('[data-testid="desktop-device-meta"]')!;
    expect(visibleText(meta)).not.toMatch(/\d+월 \d+일/);
    expect(meta.querySelector('[data-testid="viewer-tz-pending"]')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('[SID:4443] chat v3 — day separators are the viewer\'s days', () => {
  it('9/29 23:00Z and 9/30 22:18Z sit under «9월 30일» and «10월 1일» for a viewer in Seoul (was the UTC days 9/29 · 9/30)', async () => {
    fetchMock.mockImplementation(async (url: string) => (url === '/api/conversations/conv-1/messages'
      ? { ok: true, status: 200, json: async () => ({ data: [
        { id: 'm1', created_by: 'a', sender_name: '에이전트', sender_type: 'agent', content: '어제 아침', attachments: [], created_at: '2026-09-29T23:00:00Z', references: [], approval_target: null },
        { id: 'm2', created_by: 'a', sender_name: '에이전트', sender_type: 'agent', content: '오늘 아침', attachments: [], created_at: '2026-09-30T22:18:00Z', references: [], approval_target: null },
      ] }) }
      : { ok: true, status: 200, json: async () => ({ data: null }) }));
    const { ChatV3Messages } = await import('./chat-v3/chat-v3-messages');
    const ref = createRef<ChatV3MessagesHandle>();
    await act(async () => {
      root.render(page(<ChatV3Messages ref={ref} threadId="conv-1" meId="me" agentName="에이전트" locale="ko" needsMe={[]} todayV3Enabled todayHref="/today" onOpenArtifactChange={() => {}} onWorkItemRefChange={() => {}} />, 'Asia/Seoul'));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const days = [...container.querySelectorAll('p.text-center')].map((p) => visibleText(p));
    expect(days).toEqual(['9월 30일 수요일', '10월 1일 목요일']);
  });
});

describe('[SID:4443] «오늘» on /today — drawn in the server render too', () => {
  const EMPTY = { needs_me: [], needs_me_count: 0, agent_progress: [], published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } } };
  async function serverHtml(serverTimeZone: string | null): Promise<HTMLElement> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T22:39:00Z')); // 07:39 on 10/1 in Seoul
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ data: EMPTY }) }));
    const { TodayV3Screen } = await import('./today-v3/today-v3-screen');
    const el = document.createElement('div');
    el.innerHTML = renderToString(page(<TodayV3Screen />, serverTimeZone));
    return el.querySelector('[data-testid="today-v3-today-column"]') as HTMLElement;
  }

  it('the cookie says Seoul → the server render already reads «10월 1일 목요일» (a UTC server said «9월 30일 수요일»)', async () => {
    expect(visibleText(await serverHtml('Asia/Seoul'))).toContain('10월 1일 목요일');
  });

  it('a first visit (no cookie): the server render holds the place — no date to read, so nothing to correct after hydration', async () => {
    const col = await serverHtml(null);
    expect(visibleText(col)).not.toMatch(/\d+월 \d+일 [월화수목금토일]요일/);
    expect(col.querySelector('[data-testid="viewer-tz-pending"]')).not.toBeNull();
  });
});

describe('[SID:4443] the browser tells the server', () => {
  it('a first visit writes the browser\'s zone to the `tz` cookie, and the page then draws in it', async () => {
    await act(async () => { root.render(page(<span />, null)); });
    expect(document.cookie).toContain('tz=Asia/Seoul');
  });
});
