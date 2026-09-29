// @vitest-environment jsdom
//
// story #4412 — «it is already in my ad account» in the check dialog of a start stopped as «outcome unknown».
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

const spend = (errorCode: string) => jsonResponse({
  data: {
    run_status: 'pending',
    start_command: { id: 'cmd-1', status: 'dead_letter', failure_kind: 'needs_check', error_code: errorCode, campaign_name: 'Boost 1_2' },
  },
});

async function mountCard(errorCode = 'ADS_BOOST_CREATE_OUTCOME_UNKNOWN') {
  mockedFetch.mockResolvedValueOnce(spend(errorCode));
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
        <BoostExecutionControl
          orgId="org-1" gateId="gate-1" sealedAdsBudgetMinor={50_000} sealedAdsCurrency="KRW"
          sealedAdsStartsAt="2026-09-01T00:00:00Z" sealedAdsEndsAt="2026-09-19T00:00:00Z" sealedAdsObjective="POST_ENGAGEMENT"
        />
      </NextIntlClientProvider>,
    );
  });
  await flush();
}

async function linkAndStart(answer: unknown) {
  await act(async () => { $('boost-adopt-trigger')!.click(); });
  mockedFetch.mockResolvedValueOnce(jsonResponse({ data: answer }));
  mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running', start_command: null } })); // reload
  await act(async () => { $('boost-adopt-confirm')!.click(); });
  await flush();
  const call = mockedFetch.mock.calls.find(([url]) => String(url).endsWith('/ads-boosts/gate-1/adopt-existing'));
  expect(call).toBeDefined();
  expect((call![1] as RequestInit).method).toBe('POST');
}

describe('[SID:4412] «link existing campaign» (Yuna 00:49Z)', () => {
  it('the card offers link first, then retry; the confirmation shows what · campaign · money · the approved conditions, no checkbox', async () => {
    await mountCard();
    const buttons = [...container.querySelectorAll('button')].map((b) => b.getAttribute('data-testid'));
    expect(buttons.indexOf('boost-adopt-trigger')).toBeLessThan(buttons.indexOf('boost-needs-check-retry-trigger'));
    await act(async () => { $('boost-adopt-trigger')!.click(); });
    const dialog = $('boost-adopt-dialog')!;
    expect(dialog.textContent).toContain(koMessages.cage.boostAdoptTitle);
    expect(dialog.textContent).toContain(koMessages.cage.boostAdoptWhat);
    expect($('boost-adopt-campaign')?.textContent).toBe('찾을 캠페인: Boost 1_2');
    expect($('boost-adopt-weight')?.textContent).toBe(koMessages.cage.boostAdoptWeight);
    expect(dialog.textContent).toContain(koMessages.cage.adsBoostBudgetLabel); // the start confirmation's conditions
    expect(dialog.querySelector('input[type="checkbox"]')).toBeNull();
    expect(($('boost-adopt-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('adopted: the confirmation closes and the card is loaded again (no extra line)', async () => {
    await mountCard();
    await linkAndStart({ result: 'adopted', campaign_id: 'c1' });
    expect($('boost-adopt-dialog')).toBeNull();
    expect(mockedFetch.mock.calls.filter(([url]) => String(url).endsWith('/spend'))).toHaveLength(2);
  });

  it('not found: a line in the card, and the retry stays', async () => {
    await mountCard();
    await linkAndStart({ result: 'not_found' });
    expect($('boost-adopt-dialog')).toBeNull();
    expect($('boost-adopt-not-found')?.textContent).toBe(koMessages.cage.boostAdoptNotFound);
    expect($('boost-needs-check-retry-trigger')).not.toBeNull();
  });

  it('ambiguous: nothing linked, the candidates are listed in the card', async () => {
    await mountCard();
    await linkAndStart({
      result: 'ambiguous', level: 'campaign',
      candidates: [{ id: 'c1', name: 'Boost 1_2', created_time: null }, { id: 'c2', name: 'Boost 1_2', created_time: null }],
    });
    const block = $('boost-adopt-ambiguous')!;
    expect(block.textContent).toContain(koMessages.cage.boostAdoptAmbiguous);
    expect(block.querySelectorAll('li')).toHaveLength(2);
  });

  it('budget mismatch: both amounts in the card line (approved, found)', async () => {
    await mountCard();
    await linkAndStart({ result: 'budget_mismatch', level: 'adset', adset_budget_minor: 60_000, sealed_budget_minor: 50_000 });
    const line = $('boost-adopt-budget-mismatch')!.textContent ?? '';
    expect(line.indexOf('50,000')).toBeLessThan(line.indexOf('60,000')); // «승인한 총예산은 {approved}인데 … {found}»
    expect(line).not.toMatch(/\{|\}/);
    expect(line).toMatch(/60,000원이라 연결하지/); // the particle follows the amount (받침 있음 → 이라)
    expect(line).toMatch(/50,000원으로 맞춘/);
  });

  it('another needs_check stop (provider error): no link path', async () => {
    await mountCard('ADS_BOOST_PROVIDER_ERROR');
    expect($('boost-adopt-trigger')).toBeNull();
  });

  it('opening the confirmation again clears the last result line (the label and the line are never on screen together)', async () => {
    await mountCard();
    await linkAndStart({ result: 'budget_mismatch', level: 'adset', adset_budget_minor: 60_000, sealed_budget_minor: 50_000 });
    expect($('boost-adopt-budget-mismatch')).not.toBeNull();
    await act(async () => { $('boost-adopt-trigger')!.click(); });
    expect($('boost-adopt-budget-mismatch')).toBeNull();
  });
});

