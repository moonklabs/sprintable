// @vitest-environment jsdom
//
// story #4417 — the card when the ad account's currency is not the approved one (nothing created) and when the server paused
// the boost because its spend can't be checked against the budget (Yuna's wording · PO 03:51Z).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { BoostExecutionControl, isSpendCurrencyCode } from './boost-execution-control';
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
const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body), headers: { get: () => null } }) as unknown as Response;
const $ = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const ko = koMessages.cage;

async function mountWith(data: Record<string, unknown>) {
  mockedFetch.mockResolvedValueOnce(jsonResponse({ data }));
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

const mismatchStart = {
  id: 'cmd-1', status: 'dead_letter', failure_kind: 'needs_check', error_code: 'ADS_BOOST_ACCOUNT_CURRENCY_MISMATCH',
  campaign_name: null,
};

describe('[SID:4417] the ad account currency is not the approved one', () => {
  it('says both currencies and hides retry and link (a new request is the next step)', async () => {
    await mountWith({ run_status: 'pending', start_command: mismatchStart, account_currency: 'USD' });
    expect($('boost-needs-check')?.textContent).toBe(ko.boostNeedsCheckTitle);
    expect($('boost-needs-check-reason')?.textContent).toBe(
      ko.boostAccountCurrencyMismatch.replace('{accountCurrency}', 'USD').replace('{approvedCurrency}', 'KRW'),
    );
    expect($('boost-needs-check-retry-trigger')).toBeNull();
    expect($('boost-adopt-trigger')).toBeNull();
  });

  it('without the account currency the codes are left out, not guessed', async () => {
    await mountWith({ run_status: 'pending', start_command: mismatchStart, account_currency: null });
    expect($('boost-needs-check-reason')?.textContent).toBe(ko.boostAccountCurrencyMismatchNoCodes);
    expect($('boost-needs-check-retry-trigger')).toBeNull();
  });

  it('another needs_check stop keeps its retry (regression)', async () => {
    await mountWith({
      run_status: 'pending',
      start_command: { ...mismatchStart, error_code: 'META_ADS_ADSET_CREATE_FAILED' },
    });
    expect($('boost-needs-check-reason')?.textContent).toBe(ko.boostNeedsCheckStopped);
    expect($('boost-needs-check-retry-trigger')).not.toBeNull();
  });
});

describe('[SID:4417] paused because the spend cannot be checked against the budget', () => {
  it('meta: the line with the Ads Manager link, and no resume', async () => {
    const url = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=123&selected_campaign_ids=456';
    await mountWith({
      run_status: 'paused', spend_blocked_code: 'META_ADS_SPEND_CURRENCY_MISMATCH',
      ad_channel: 'meta_ads', ad_account_id: '123', campaign_id: '456',
    });
    expect($('boost-spend-unreadable')?.textContent).toBe(ko.boostSpendUnreadablePaused);
    const link = $('boost-ads-manager-link') as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe(url);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.textContent).toContain(ko.boostOpenAdsManager);
    // the cap notice's link shape (4820): its own line, not inside the sentence
    expect(link?.className).toContain('text-primary');
    expect($('boost-spend-unreadable')?.contains(link)).toBe(false);
    expect($('boost-resume-trigger')).toBeNull();
  });

  it('stopped for repeated read failures: the line without a reason — never «another currency» (Yuna 5883612567)', async () => {
    await mountWith({ run_status: 'paused', spend_blocked_code: 'ADS_SPEND_READ_FAILED_REPEATEDLY', ad_channel: 'ads_sandbox' });
    expect($('boost-spend-unreadable')?.textContent).toBe(ko.boostSpendUncheckedPaused);
    expect($('boost-ads-manager-link')).toBeNull();  // sandbox: no link
    expect($('boost-resume-trigger')).toBeNull();
  });

  it('code → line: only the two currency codes say «another currency»; anything else, known or not, has no reason', async () => {
    expect(isSpendCurrencyCode('META_ADS_SPEND_CURRENCY_MISMATCH')).toBe(true);
    expect(isSpendCurrencyCode('META_ADS_SPEND_UNKNOWN_CURRENCY')).toBe(true);
    expect(isSpendCurrencyCode('ADS_SPEND_READ_FAILED_REPEATEDLY')).toBe(false);
    await mountWith({ run_status: 'paused', spend_blocked_code: 'A_CODE_ADDED_LATER', ad_channel: 'ads_sandbox' });
    expect($('boost-spend-unreadable')?.textContent).toBe(ko.boostSpendUncheckedPaused);
  });

  it('sandbox currency stop: the currency line without a link, and no resume', async () => {
    await mountWith({ run_status: 'paused', spend_blocked_code: 'META_ADS_SPEND_UNKNOWN_CURRENCY', ad_channel: 'ads_sandbox' });
    expect($('boost-spend-unreadable')?.textContent).toBe(ko.boostSpendUnreadablePaused);
    expect($('boost-ads-manager-link')).toBeNull();
    expect($('boost-resume-trigger')).toBeNull();
  });

  it('before the pause is in effect (still running) there is no line yet', async () => {
    await mountWith({ run_status: 'running', spend_blocked_code: 'META_ADS_SPEND_CURRENCY_MISMATCH' });
    expect($('boost-spend-unreadable')).toBeNull();
    expect($('boost-pause-trigger')).not.toBeNull();
  });

  it('a paused boost that is not blocked keeps its resume (regression)', async () => {
    await mountWith({ run_status: 'paused', spend_blocked_code: null });
    expect($('boost-spend-unreadable')).toBeNull();
    expect($('boost-resume-trigger')).not.toBeNull();
  });
});

describe('[SID:4417] the ad connection is gone (Qadir 01a0eb71 A)', () => {
  it('says to stop it in Ads Manager whatever the run status, and offers no pause or resume (they cannot reach Meta)', async () => {
    await mountWith({ run_status: 'running', spend_blocked_code: 'ADS_SPEND_CONTEXT_LOST', ad_channel: null, campaign_name: 'Boost 1_2' });
    expect($('boost-spend-context-lost')?.textContent).toBe(ko.boostSpendContextLost);
    expect($('boost-spend-context-lost')?.className).toContain('text-foreground'); // the money line's weight (4820), not a side note
    // no connection → no account to link to: the campaign to look for is named instead (Yuna)
    expect($('boost-spend-context-lost-campaign')?.textContent).toBe(ko.boostNeedsCheckCampaignToFind.replace('{campaignName}', 'Boost 1_2'));
    expect($('boost-ads-manager-link')).toBeNull();
    expect($('boost-spend-unreadable')).toBeNull();
    expect($('boost-pause-trigger')).toBeNull();
    expect($('boost-resume-trigger')).toBeNull();
  });
});

