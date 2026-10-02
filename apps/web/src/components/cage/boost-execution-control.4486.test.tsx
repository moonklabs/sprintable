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

let refuseWithCap = false;

beforeEach(() => {
  refuseWithCap = false;
  mockedFetch.mockReset();
  mockedFetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/spend') && !init) return jsonResponse({ data: spendNow });
    if (refuseWithCap && init) return jsonResponse({ error: { code: 'ADS_BOOST_CAP_REACHED', message: 'server words' } }, 409);
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

  // Yuna 04:02Z — the refusal at the cap says why and the way on, never the generic «failed»
  it('a start refused at the cap says so inside the start dialog', async () => {
    spendNow = { run_status: null, start_command: null, gate_status: 'approved' };
    refuseWithCap = true;
    await mount();
    await act(async () => { $('boost-start-trigger')!.click(); });
    await act(async () => { $('boost-start-confirm')!.click(); });
    await flush();
    const dialog = $('boost-start-confirm-dialog')!;
    expect(dialog.querySelector('[data-testid="boost-dialog-error"]')?.textContent).toBe(cage.boostStartBlockedCapReached);
    // Yuna CHANGES ⓑ — after that refusal [시작] is off; only the dialog's close button is left to press
    expect(($('boost-start-confirm') as HTMLButtonElement).disabled).toBe(true);
    const close = [...dialog.querySelectorAll('button')].find((b) => b.textContent === cage.boostExecutionCancel) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
  });

  it('a capped cycle offers no [홍보 시작] whatever the run says — the fact as a muted line, [홍보 취소] kept', async () => {
    spendNow = { run_status: null, start_command: null, gate_status: 'approved', can_cancel: true, cap_reached_at: '2026-10-02T01:52:42Z' };
    await mount();
    expect($('boost-start-trigger')).toBeNull();
    const line = $('boost-start-blocked-cap')!;
    expect(line.textContent).toBe(cage.boostStartBlockedCapReached);
    expect(line.className).toContain('text-muted-foreground');
    expect($('boost-cancel-trigger')).not.toBeNull();
  });

  it('a start the worker stopped at the cap reads the same sentence on the card', async () => {
    spendNow = {
      run_status: 'pending', gate_status: 'approved',
      start_command: { id: 'cmd-2', status: 'blocked_unapproved', failure_kind: null, error_code: 'ADS_BOOST_CAP_REACHED', campaign_name: null, retryable: false },
    };
    await mount();
    expect($('boost-start-failed')?.textContent).toBe(cage.boostStartBlockedCapReached);
  });

  it('a resume refused at the cap (a card that had not caught up) says why', async () => {
    spendNow = { run_status: 'paused', start_command: started, gate_status: 'approved', cap_reached_at: null };
    refuseWithCap = true;
    await mount();
    await act(async () => { $('boost-resume-trigger')!.click(); });
    await flush();
    expect($('boost-execution-error')?.textContent).toBe(cage.boostCapReachedNoResume);
  });
});
