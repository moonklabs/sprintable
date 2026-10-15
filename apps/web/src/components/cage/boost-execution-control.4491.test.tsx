// @vitest-environment jsdom
//
// story #4491 (Yuna 06:27Z) — under «취소 중», a pause the provider refused is said at once, in the 4461 line's place and shape:
// retrying («광고를 멈추지 못했어요 — 자동으로 다시 멈춰 볼게요. …») or no automatic try left («… 광고 관리자에서 직접 멈춰 주세요.» +
// the Ads Manager link, Meta only). Sandbox: the short forms, no link. While that line shows, the 3-minute pause notice does not
// (the same fact later and less exact). Decided by the server's pause_retry, not guessed from the pause's status.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { BoostExecutionControl } from './boost-execution-control';
import { fetchWithAuth } from '@/lib/db/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useConnectRulesHref: (p: string) => `/ws/proj${p}`,
  useDashboardContext: () => ({ projectId: 'proj-1', inShell: true }),
}));
const mockedFetch = vi.mocked(fetchWithAuth);
const cage = koMessages.cage;

let container: HTMLDivElement;
let root: Root;
let spendNow: Record<string, unknown>;

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), headers: { get: () => null } }) as unknown as Response;
const $ = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const started = { id: 'cmd-1', status: 'completed', failure_kind: null, error_code: null, campaign_name: 'Boost 1', retryable: false };
const cancelling = (channel: string, pauseRetry: string | null) => ({
  run_status: 'running', start_command: started, gate_status: 'voided', cancel_requested: true, pause_retry: pauseRetry,
  pause_command: { status: 'dead_letter', failure_kind: 'needs_check', error_code: 'META_ADS_PAUSE_FAILED' },
  ad_channel: channel, ad_account_id: '1234567890', campaign_id: '120200000001', campaign_name: 'Boost 1',
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-02T06:00:00Z'));
  mockedFetch.mockReset();
  mockedFetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/spend') && !init) return jsonResponse({ data: spendNow });
    return jsonResponse({ data: {} });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
});

const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
        <BoostExecutionControl
          orgId="org-1" gateId="gate-1" sealedAdsBudgetMinor={30_000} sealedAdsCurrency="KRW"
          sealedAdsStartsAt="2026-09-01T00:00:00Z" sealedAdsEndsAt="2026-10-19T00:00:00Z" sealedAdsObjective="POST_ENGAGEMENT"
          gateStatus="voided"
        />
      </NextIntlClientProvider>,
    );
  });
  await settle();
}

describe('[SID:4491] «취소 중» with a pause the provider refused', () => {
  it('retrying (Meta): said at once under «취소 중», and no 3-minute notice after', async () => {
    spendNow = cancelling('meta_ads', 'scheduled');
    await mount();
    expect($('boost-cancelling')).not.toBeNull();
    expect($('boost-cancel-pause-failed')?.textContent).toBe(cage.boostCancelPauseFailedRetrying);
    expect($('boost-cancel-pause-failed-link')).toBeNull();
    await settle(3 * 60_000 + 10_000);
    expect($('boost-execution-cap-notice')).toBeNull();
  });

  it('no automatic try left (Meta): the Ads Manager sentence and its link', async () => {
    spendNow = cancelling('meta_ads', 'exhausted');
    await mount();
    expect($('boost-cancel-pause-failed')?.textContent).toBe(cage.boostCancelPauseFailedExhausted);
    expect($('boost-cancel-pause-failed-link')?.getAttribute('href')).toContain('120200000001');
  });

  it.each([
    ['scheduled', 'boostCancelPauseFailedRetryingSandbox'],
    ['exhausted', 'boostCancelPauseFailedExhaustedSandbox'],
  ] as const)('sandbox %s: the short form, no link', async (retry, key) => {
    spendNow = cancelling('ads_sandbox', retry);
    await mount();
    expect($('boost-cancel-pause-failed')?.textContent).toBe((cage as Record<string, string>)[key]);
    expect($('boost-cancel-pause-failed-link')).toBeNull();
  });

  it('no failed pause: «취소 중» alone, and the 3-minute notice as before', async () => {
    spendNow = { ...cancelling('ads_sandbox', null), pause_command: { status: 'pending', failure_kind: null, error_code: null } };
    await mount();
    expect($('boost-cancel-pause-failed')).toBeNull();
    await settle(3 * 60_000 + 10_000);
    expect($('boost-execution-cap-notice')).not.toBeNull();
  });
});
