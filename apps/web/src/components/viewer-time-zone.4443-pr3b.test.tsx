// @vitest-environment jsdom
//
// story #4443 PR3b — a promised time (a content schedule, an ad window) is the team's: the org's zone (#3422). The input reads the
// typed wall clock in it, and says so beside the input only when that offset is not the viewer's (Yuna 03:27Z: «조직 시간 ·
// GMT+9» · Seoul ↔ Tokyo says nothing). The process zone is pinned to UTC for this file (PO 22:55Z).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../messages/ko.json';
import { ViewerTimeZoneProvider } from './viewer-time-zone';
import { teamOffsetCaption } from './content/schedule-format';

const { runtimeTz, orgTz } = vi.hoisted(() => ({ runtimeTz: { value: 'America/Los_Angeles' as string | null }, orgTz: { value: 'Asia/Seoul' as string | null } }));
vi.mock('@/lib/viewer-time-zone', async (orig) => ({ ...(await orig<typeof import('@/lib/viewer-time-zone')>()), runtimeTimeZone: () => runtimeTz.value }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ orgTimezone: orgTz.value }) }));

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
  runtimeTz.value = 'America/Los_Angeles';
  orgTz.value = 'Asia/Seoul';
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('[SID:4443 PR3b] the caption beside a promised-time input', () => {
  const at = new Date('2026-09-04T10:00:00Z');
  it('the org\'s offset when it is not the viewer\'s · nothing when they agree (Seoul ↔ Tokyo) · nothing while either is unknown', () => {
    expect(teamOffsetCaption(at, 'Asia/Seoul', 'America/Los_Angeles')).toBe('GMT+9');
    expect(teamOffsetCaption(at, 'Asia/Seoul', 'Asia/Tokyo')).toBeNull();
    expect(teamOffsetCaption(at, 'Asia/Seoul', 'Asia/Seoul')).toBeNull();
    expect(teamOffsetCaption(at, 'UTC', 'Asia/Seoul')).toBe('GMT');
    expect(teamOffsetCaption(at, null, 'Asia/Seoul')).toBeNull();
    expect(teamOffsetCaption(at, 'Asia/Seoul', null)).toBeNull();
  });
});

describe('[SID:4443 PR3b] the content schedule dialog reads the time in the org\'s zone', () => {
  async function open(onSubmit: (iso: string) => void) {
    const { ScheduleAtDialog } = await import('./content/schedule-at-dialog');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
          <ViewerTimeZoneProvider serverTimeZone={runtimeTz.value}><ScheduleAtDialog open onOpenChange={() => {}} onSubmit={onSubmit} /></ViewerTimeZoneProvider>
        </NextIntlClientProvider>,
      );
    });
  }
  async function type(value: string) {
    const input = document.querySelector('[data-testid="channel-post-schedule-at-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (document.querySelector('[data-testid="channel-post-schedule-at-confirm"]') as HTMLElement).click(); });
  }

  it('a Seoul org seen from Los Angeles: «조직 시간 · GMT+9» beside the input (tied by aria-describedby) · «14:30» is Seoul\'s 14:30', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-04T10:00:00Z'));
    const sent: string[] = [];
    await open((iso) => sent.push(iso));
    const caption = document.querySelector('[data-testid="channel-post-schedule-at-org-time"]');
    expect(caption?.textContent).toBe('조직 시간 · GMT+9');
    expect(document.querySelector('[data-testid="channel-post-schedule-at-input"]')?.getAttribute('aria-describedby')).toBe(caption?.id);
    await type('2026-09-05T14:30');
    expect(sent).toEqual(['2026-09-05T05:30:00.000Z']); // was the browser's 14:30 (Los Angeles): 21:30Z
  });

  it('the org\'s offset is the viewer\'s (a Seoul org seen from Tokyo): no caption', async () => {
    runtimeTz.value = 'Asia/Tokyo';
    await open(() => {});
    expect(document.querySelector('[data-testid="channel-post-schedule-at-org-time"]')).toBeNull();
    expect(document.querySelector('[data-testid="channel-post-schedule-at-input"]')?.getAttribute('aria-describedby')).toBeNull();
  });

  it('an org with no zone: the viewer\'s zone, no caption', async () => {
    orgTz.value = null;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-04T10:00:00Z'));
    const sent: string[] = [];
    await open((iso) => sent.push(iso));
    expect(document.querySelector('[data-testid="channel-post-schedule-at-org-time"]')).toBeNull();
    await type('2026-09-05T14:30');
    expect(sent).toEqual(['2026-09-05T21:30:00.000Z']); // Los Angeles 14:30
  });
});
