// @vitest-environment jsdom
//
// story #4409 — a boost start stopped for a person to check is visible, and «outcome unknown» is retried only after the person
// confirms the campaign does not exist in the ad account.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { BoostExecutionControl } from './boost-execution-control';
import { fetchWithAuth } from '@/lib/db/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));
const mockedFetch = vi.mocked(fetchWithAuth);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockedFetch.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), headers: { get: () => null } }) as unknown as Response;
const $ = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

const SEALED = {
  sealedAdsBudgetMinor: 50_000, sealedAdsCurrency: 'KRW', sealedAdsStartsAt: '2026-09-01T00:00:00Z',
  sealedAdsEndsAt: '2026-09-19T00:00:00Z', sealedAdsObjective: 'POST_ENGAGEMENT',
};

const spend = (errorCode: string | null, campaignName: string | null = null) => jsonResponse({
  data: {
    run_status: 'pending',
    start_command: { id: 'cmd-1', status: 'dead_letter', failure_kind: 'needs_check', error_code: errorCode, campaign_name: campaignName },
  },
});

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
        <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} />
      </NextIntlClientProvider>,
    );
  });
  await flush();
}

async function retryThroughTheDialog() {
  await act(async () => { $('boost-needs-check-retry-trigger')!.click(); });
  const confirm = $('boost-needs-check-confirm') as HTMLButtonElement;
  expect(confirm.disabled).toBe(true); // locked until the person ticks the check
  await act(async () => { $('boost-needs-check-confirm-checklist')!.click(); });
  expect(confirm.disabled).toBe(false);
  mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'cmd-1', status: 'pending' } }));
  mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'pending', start_command: null } }));
  await act(async () => { confirm.click(); });
  await flush();
  const call = mockedFetch.mock.calls.find(([url]) => String(url).endsWith('/publication-commands/cmd-1/retry'));
  expect(call).toBeDefined();
  return JSON.parse(String((call![1] as RequestInit).body));
}

describe('[SID:4409] BoostExecutionControl — a start that needs a check', () => {
  it('outcome unknown: «needs your check» instead of «start», and the retry carries the no-campaign confirmation', async () => {
    mockedFetch.mockResolvedValueOnce(spend('ADS_BOOST_CREATE_OUTCOME_UNKNOWN', 'Boost 123_456'));
    await mount();
    expect($('boost-needs-check')?.textContent).toBe(koMessages.cage.boostNeedsCheckTitle);
    expect(container.textContent).toContain(koMessages.cage.boostNeedsCheckOutcomeUnknown);
    expect($('boost-start-trigger')).toBeNull(); // pressing «start» only returned the same stopped command
    await act(async () => { $('boost-needs-check-retry-trigger')!.click(); });
    const dialog = $('boost-needs-check-dialog')!;
    expect(dialog.textContent).toContain(koMessages.cage.boostNeedsCheckConfirmTitle);
    expect(dialog.textContent).toContain(koMessages.cage.boostNeedsCheckWhatOutcomeUnknown);
    expect($('boost-needs-check-weight')?.textContent).toBe(koMessages.cage.boostNeedsCheckWeightOutcomeUnknown);
    expect($('boost-needs-check-campaign')?.textContent).toBe('찾을 캠페인: Boost 123_456');
    expect(dialog.textContent).toContain(koMessages.cage.boostNeedsCheckConfirmNoCampaign);
    await act(async () => { $('boost-needs-check-dialog')!.querySelector('button')!.click(); }); // cancel
    expect(await retryThroughTheDialog()).toEqual({ confirmed_no_campaign: true });
  });

  it('another needs_check stop (provider error): same place, plain retry (no confirmation flag)', async () => {
    mockedFetch.mockResolvedValueOnce(spend('ADS_BOOST_PROVIDER_ERROR'));
    await mount();
    expect(container.textContent).toContain(koMessages.cage.boostNeedsCheckStopped);
    expect($('boost-start-trigger')).toBeNull();
    await act(async () => { $('boost-needs-check-retry-trigger')!.click(); });
    expect($('boost-needs-check-dialog')!.textContent).toContain(koMessages.cage.boostNeedsCheckWhatStopped);
    expect($('boost-needs-check-weight')).toBeNull(); // the weight / campaign lines are for «outcome unknown» only
    expect($('boost-needs-check-campaign')).toBeNull();
    await act(async () => { $('boost-needs-check-dialog')!.querySelector('button')!.click(); }); // cancel
    expect(await retryThroughTheDialog()).toEqual({ confirmed_no_campaign: false });
  });

  it.each([
    ['no start command yet', null],
    ['a transient retry pending', { status: 'pending', failure_kind: 'transient' }],
  ])('%s: the start button as before, no «needs your check»', async (_label, command) => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({
      data: { run_status: 'pending', start_command: command ? { id: 'cmd-1', error_code: null, ...command } : null },
    }));
    await mount();
    expect($('boost-needs-check')).toBeNull();
    expect($('boost-start-trigger')).not.toBeNull();
  });
});
