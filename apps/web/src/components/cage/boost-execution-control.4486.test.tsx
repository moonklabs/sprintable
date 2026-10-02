// @vitest-environment jsdom
//
// story #4486 (Yuna 02:54Z) — a boost paused at its cap says so in one line («쓴 광고비가 총예산({amount})에 닿아 홍보를 멈췄어요 —
// 더는 광고비가 나가지 않아요.» · the sealed budget) and offers no [재개] (the server refuses it: more spend is a new request). One
// line only, in the server's reason order: the cap before an unreadable spend and before a withdrawn approval.
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
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const started = { id: 'cmd-1', status: 'completed', failure_kind: null, error_code: null, campaign_name: null, retryable: false };
const capLine = cage.boostPausedCapReached.replace('{amount}', '30,000원');

beforeEach(() => {
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
});

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
        <BoostExecutionControl
          orgId="org-1" gateId="gate-1" sealedAdsBudgetMinor={30_000} sealedAdsCurrency="KRW"
          sealedAdsStartsAt="2026-09-01T00:00:00Z" sealedAdsEndsAt="2026-10-19T00:00:00Z" sealedAdsObjective="POST_ENGAGEMENT"
          gateStatus="approved"
        />
      </NextIntlClientProvider>,
    );
  });
  await flush();
}

describe('[SID:4486] a boost paused at its cap', () => {
  it('says the cap with the sealed budget and offers no resume', async () => {
    spendNow = { run_status: 'paused', start_command: started, gate_status: 'approved', cap_reached_at: '2026-10-02T01:52:42Z' };
    await mount();
    expect($('boost-paused-cap-reached')?.textContent).toBe(capLine);
    expect($('boost-resume-trigger')).toBeNull();
  });

  it('one line only: the cap before a withdrawn approval and before an unreadable spend', async () => {
    spendNow = {
      run_status: 'paused', start_command: started, gate_status: 'pending', cap_reached_at: '2026-10-02T01:52:42Z',
      spend_blocked_code: 'ADS_SPEND_UNREADABLE',
    };
    await mount();
    expect($('boost-paused-cap-reached')?.textContent).toBe(capLine);
    expect($('boost-paused-approval-gone')).toBeNull();
    expect($('boost-spend-unreadable')).toBeNull();
    expect($('boost-resume-trigger')).toBeNull();
  });

  it('a person\'s pause (no cap) still offers resume and says nothing about the cap', async () => {
    spendNow = { run_status: 'paused', start_command: started, gate_status: 'approved', cap_reached_at: null };
    await mount();
    expect($('boost-paused-cap-reached')).toBeNull();
    expect($('boost-resume-trigger')).not.toBeNull();
  });
});
