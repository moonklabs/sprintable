// @vitest-environment jsdom
//
// story #4443 PR2a — the places that drew «when it happened» in the runtime's zone, and in a hard-coded Korean locale (the chat
// bubble said «오전 07:32» in English too). Now the viewer's zone and locale (Yuna 22:45Z: ko «오전 7:18» · en «7:18 AM»).
// The process zone is pinned to UTC for this file (a server's zone · no machine-dependent result — PO 22:55Z).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';
import { ViewerTimeZoneProvider, ViewerDate } from './viewer-time-zone';
import { VIEWER_TIME_OPTIONS, formatViewerDate } from '@/lib/viewer-time-zone';
import type { ChatMessage } from '@/hooks/use-chat-sse';

const { runtimeTz } = vi.hoisted(() => ({ runtimeTz: { value: 'Asia/Seoul' as string | null } }));
vi.mock('@/lib/viewer-time-zone', async (orig) => ({ ...(await orig<typeof import('@/lib/viewer-time-zone')>()), runtimeTimeZone: () => runtimeTz.value }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectId: 'p', currentTeamMemberId: 'm', currentMemberType: 'human', role: 'member', projectMemberships: [] }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let processTz: string | undefined;
beforeAll(() => { processTz = process.env.TZ; process.env.TZ = 'UTC'; });
afterAll(() => { if (processTz === undefined) delete process.env.TZ; else process.env.TZ = processTz; });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  runtimeTz.value = 'Asia/Seoul';
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

// What the runtime's own Intl draws for that locale · zone · options (story #4446, PO 02:01Z). ICU's words differ between Node
// patches — v22.23.2 drew ko «AM 7:18», v22.23.3 «오전 7:18» — so the expected text is never typed in; the parts check that the
// right zone was used (Seoul 7:18 · Los Angeles 3:18), whatever the ICU wording.
function intl(value: string | Date, locale: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(value));
}
function part(value: string | Date, locale: string, timeZone: string, options: Intl.DateTimeFormatOptions, type: Intl.DateTimeFormatPartTypes): string | undefined {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).formatToParts(new Date(value)).find((p) => p.type === type)?.value;
}

function visibleText(el: Element): string {
  const c = el.cloneNode(true) as Element;
  c.querySelectorAll('[data-testid="viewer-tz-pending"]').forEach((n) => n.remove());
  return c.textContent ?? '';
}

// next-intl as the server hands it down when the zone is unknown (UTC); the viewer's zone comes from the provider only
function page(node: React.ReactNode, locale: 'ko' | 'en', viewerTz: string | null) {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="UTC">
      <ViewerTimeZoneProvider serverTimeZone={viewerTz}>{node}</ViewerTimeZoneProvider>
    </NextIntlClientProvider>
  );
}

const message: ChatMessage = {
  id: 'msg-1', memo_id: 'conv-1', created_by: 'agent-1', sender_name: '에이전트', sender_type: 'agent', sender_avatar_url: null,
  sender_runtime_type: null, content: '확인했어요.', attachments: [], created_at: '2026-09-30T22:18:00.000Z',
};

describe('[SID:4443 PR2a] the chat bubble\'s time — the viewer\'s zone and locale', () => {
  it('ko viewer in Seoul: «오전 7:18» (was ko-KR two-digit in the runtime\'s zone: «오후 10:18» on a UTC server)', async () => {
    const { ChatBubble } = await import('./chat/chat-bubble');
    await act(async () => { root.render(page(<ChatBubble message={message} isMine={false} />, 'ko', 'Asia/Seoul')); });
    expect(visibleText(container.querySelector('time')!)).toBe(intl(message.created_at, 'ko', 'Asia/Seoul', VIEWER_TIME_OPTIONS));
    expect([part(message.created_at, 'ko', 'Asia/Seoul', VIEWER_TIME_OPTIONS, 'hour'), part(message.created_at, 'ko', 'Asia/Seoul', VIEWER_TIME_OPTIONS, 'minute')]).toEqual(['7', '18']);
  });

  it('en viewer in Los Angeles: «3:18 PM» — their clock, their language (was «오후 10:18» in English too)', async () => {
    runtimeTz.value = 'America/Los_Angeles';
    const { ChatBubble } = await import('./chat/chat-bubble');
    await act(async () => { root.render(page(<ChatBubble message={message} isMine={false} />, 'en', 'America/Los_Angeles')); });
    expect(visibleText(container.querySelector('time')!)).toBe(intl(message.created_at, 'en', 'America/Los_Angeles', VIEWER_TIME_OPTIONS));
    expect([part(message.created_at, 'en', 'America/Los_Angeles', VIEWER_TIME_OPTIONS, 'hour'), part(message.created_at, 'en', 'America/Los_Angeles', VIEWER_TIME_OPTIONS, 'minute')]).toEqual(['3', '18']);
  });

  it('the zone not known yet: no time can be read (the place is held)', async () => {
    runtimeTz.value = null;
    const { ChatBubble } = await import('./chat/chat-bubble');
    await act(async () => { root.render(page(<ChatBubble message={message} isMine={false} />, 'ko', null)); });
    const time = container.querySelector('time')!;
    expect(visibleText(time)).toBe('');
    expect(time.querySelector('[data-testid="viewer-tz-pending"]')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('[SID:4443 PR2a] the one formatter', () => {
  it('names the zone it draws in · null while unknown · \'\' for a value that is not a date', () => {
    const at = '2026-09-30T22:18:00Z';
    expect(formatViewerDate(at, 'ko', 'Asia/Seoul', VIEWER_TIME_OPTIONS)).toBe(intl(at, 'ko', 'Asia/Seoul', VIEWER_TIME_OPTIONS));
    expect(formatViewerDate(at, 'en', 'Asia/Seoul', VIEWER_TIME_OPTIONS)).toBe(intl(at, 'en', 'Asia/Seoul', VIEWER_TIME_OPTIONS));
    expect(part(at, 'en', 'Asia/Seoul', VIEWER_TIME_OPTIONS, 'hour')).toBe('7'); // the next morning in Seoul, not 22:18 UTC
    const md = { month: 'numeric', day: 'numeric' } as const;
    expect(formatViewerDate(at, 'ko', 'Asia/Seoul', md)).toBe(intl(at, 'ko', 'Asia/Seoul', md));
    expect([part(at, 'ko', 'Asia/Seoul', md, 'month'), part(at, 'ko', 'Asia/Seoul', md, 'day')]).toEqual(['10', '1']);
    expect(formatViewerDate('2026-09-30T22:18:00Z', 'ko', null, VIEWER_TIME_OPTIONS)).toBeNull();
    expect(formatViewerDate('nope', 'ko', 'Asia/Seoul', VIEWER_TIME_OPTIONS)).toBe('');
  });

  it('ViewerDate: the viewer\'s «today» (org-briefing) is their day, not the runtime\'s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T22:39:00Z'));
    try {
      await act(async () => { root.render(page(<p><ViewerDate value={new Date()} options={{ month: 'long', day: 'numeric', weekday: 'long' }} /></p>, 'ko', 'Asia/Seoul')); });
      const opts = { month: 'long', day: 'numeric', weekday: 'long' } as const;
      expect(visibleText(container)).toBe(intl(new Date('2026-09-30T22:39:00Z'), 'ko', 'Asia/Seoul', opts));
      expect(part(new Date('2026-09-30T22:39:00Z'), 'ko', 'Asia/Seoul', opts, 'day')).toBe('1'); // Seoul's day, not the runtime's 30th
    } finally {
      vi.useRealTimers();
    }
  });
});
