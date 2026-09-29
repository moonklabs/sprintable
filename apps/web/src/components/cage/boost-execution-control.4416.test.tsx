// @vitest-environment jsdom
//
// story #4416 — the boost card reads /spend until a queued start · pause · resume lands, so a running promotion shows «running ·
// pause» without a refresh. 5 s for the first 3 min, then 30 s, up to 35 min for a start; 3 min for pause and resume. Hidden
// tab = no reads (one read on return), unmount = no reads, the cap leaves a notice (pause: the money line, and for Meta ads the
// campaign and a link to stop it in Ads Manager).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { BoostExecutionControl, adsManagerCampaignUrl } from './boost-execution-control';
import { fetchWithAuth } from '@/lib/db/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));
const mockedFetch = vi.mocked(fetchWithAuth);
const cage = koMessages.cage;

let container: HTMLDivElement;
let root: Root;
let hidden = false;
// what GET /spend answers now (the test changes it as the worker would)
let spendNow: Record<string, unknown>;
// a GET /spend that does not come back until the test lets it
let holdSpend: { release: () => void } | null = null;
// GET /spend answers 500 while this is set (a /spend that keeps failing)
let failSpend = false;
// a POST that does not come back until the test lets it
let holdPost: { release: () => void } | null = null;

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), headers: { get: () => null } }) as unknown as Response;
const $ = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const spendReads = () => mockedFetch.mock.calls.filter(([url, init]) => String(url).endsWith('/spend') && !init).length;
const posts = (suffix: string) => mockedFetch.mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && init).length;

const startCommand = (status: string, failureKind: string | null = null) =>
  ({ id: 'cmd-1', status, failure_kind: failureKind, error_code: null, campaign_name: null });
const RUN_AD = { campaign_id: '120200000001', ad_account_id: '1234567890', campaign_name: 'Boost 111_222', ad_channel: 'meta_ads' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-09-29T03:00:00Z'));
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  holdSpend = null;
  failSpend = false;
  holdPost = null;
  spendNow = { run_status: null, start_command: null };
  mockedFetch.mockReset();
  mockedFetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/spend') && !init) {
      const body = { data: spendNow };
      if (holdSpend) await new Promise<void>((resolve) => { holdSpend = { release: resolve }; });
      return failSpend ? jsonResponse({ error: 'boom' }, 500) : jsonResponse(body);
    }
    if (holdPost && init) await new Promise<void>((resolve) => { holdPost = { release: resolve }; });
    if (String(url).endsWith('/adopt-existing')) {
      spendNow = { run_status: 'pending', start_command: startCommand('pending') }; // linking queues the start again
      return jsonResponse({ data: { result: 'adopted' } });
    }
    if (String(url).endsWith('/spend/refresh')) {
      return jsonResponse({ data: { spend_minor: 1_000, captured_at: '2026-09-29T03:00:00Z', cap_reached: false, run_status: 'running' } }, 201);
    }
    return jsonResponse({ data: { id: 'cmd-1', status: 'pending' } }, 201);
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
          orgId="org-1" gateId="gate-1" sealedAdsBudgetMinor={50_000} sealedAdsCurrency="KRW"
          sealedAdsStartsAt="2026-09-01T00:00:00Z" sealedAdsEndsAt="2026-10-19T00:00:00Z" sealedAdsObjective="POST_ENGAGEMENT"
        />
      </NextIntlClientProvider>,
    );
  });
  await settle();
}

async function pressStart() {
  await act(async () => { $('boost-start-trigger')!.click(); });
  spendNow = { run_status: 'pending', start_command: startCommand('pending') };
  await act(async () => { $('boost-start-confirm')!.click(); });
  await settle();
}

const setHidden = async (value: boolean) => {
  hidden = value;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await settle();
};

describe('[SID:4416] BoostExecutionControl — reads /spend until the queued command lands', () => {
  it('start: pending → running shows «running · pause» without a refresh, then stops reading', async () => {
    await mount();
    await pressStart();
    expect(posts('/start')).toBe(1);
    expect($('boost-execution-waiting')?.textContent).toBe(cage.boostExecutionStarting);
    expect(($('boost-start-trigger') as HTMLButtonElement).disabled).toBe(true); // no second start while it waits
    const afterPress = spendReads();

    await settle(5_000);
    expect(spendReads()).toBe(afterPress + 1); // still pending: read again in 5 s
    expect($('boost-pause-trigger')).toBeNull();

    spendNow = { run_status: 'running', start_command: startCommand('completed'), ...RUN_AD }; // the worker ran it
    await settle(5_000);
    expect(container.textContent).toContain(cage.boostExecutionStatusRunning);
    expect($('boost-pause-trigger')?.textContent).toBe(cage.boostExecutionPause);
    expect($('boost-execution-waiting')).toBeNull();

    const settled = spendReads();
    await settle(10 * 60_000);
    expect(spendReads()).toBe(settled); // a terminal state ends the reads
  });

  it('a start already queued at mount (e.g. after «link existing campaign») is read the same way', async () => {
    spendNow = { run_status: 'pending', start_command: startCommand('pending') };
    await mount();
    expect($('boost-execution-waiting')?.textContent).toBe(cage.boostExecutionStarting);
    spendNow = { run_status: 'running', start_command: startCommand('completed'), ...RUN_AD };
    await settle(5_000);
    expect($('boost-pause-trigger')).not.toBeNull();
  });

  it('«link existing campaign» (4412): the link POST → pending → running shows «running · pause» without a refresh', async () => {
    spendNow = {
      run_status: 'pending',
      start_command: { id: 'cmd-1', status: 'dead_letter', failure_kind: 'needs_check', error_code: 'ADS_BOOST_CREATE_OUTCOME_UNKNOWN', campaign_name: 'Boost 111_222' },
    };
    await mount();
    await act(async () => { $('boost-adopt-trigger')!.click(); });
    await act(async () => { $('boost-adopt-confirm')!.click(); });
    await settle();
    expect(posts('/adopt-existing')).toBe(1);
    expect($('boost-execution-waiting')?.textContent).toBe(cage.boostExecutionStarting); // the wait begins from the command state
    expect($('boost-pause-trigger')).toBeNull();

    spendNow = { run_status: 'running', start_command: startCommand('completed'), ...RUN_AD }; // the worker linked it
    await settle(5_000);
    expect(container.textContent).toContain(cage.boostExecutionStatusRunning);
    expect($('boost-pause-trigger')?.textContent).toBe(cage.boostExecutionPause);
  });

  it('a start retrying on its own (transient) says so instead of «starting…»', async () => {
    spendNow = { run_status: 'pending', start_command: startCommand('in_progress', 'transient') };
    await mount();
    expect($('boost-execution-waiting')?.textContent).toBe(cage.boostExecutionStartRetrying);
  });

  it.each([
    ['completed', 'running'], ['dead_letter', 'pending'], ['failed', 'pending'], ['voided', 'pending'], ['blocked', 'pending'],
  ])('start command %s (run %s) ends the reads', async (status, run) => {
    spendNow = { run_status: 'pending', start_command: startCommand('pending') };
    await mount();
    spendNow = { run_status: run, start_command: startCommand(status, status === 'dead_letter' ? 'needs_check' : null) };
    await settle(5_000);
    const reads = spendReads();
    await settle(5 * 60_000);
    expect(spendReads()).toBe(reads);
  });

  it('5 s for the first 3 min, then 30 s; after 35 min the start notice and no more reads', async () => {
    spendNow = { run_status: 'pending', start_command: startCommand('pending') };
    await mount();
    const first = spendReads();
    await settle(3 * 60_000);
    expect(spendReads() - first).toBe(36); // every 5 s
    const slow = spendReads();
    await settle(60_000);
    expect(spendReads() - slow).toBe(2); // every 30 s
    await settle(35 * 60_000);
    expect($('boost-execution-cap-notice')?.textContent).toBe(cage.boostExecutionStartCapNotice);
    expect($('boost-execution-waiting')).toBeNull();
    const capped = spendReads();
    await settle(10 * 60_000);
    expect(spendReads()).toBe(capped);
  });

  it('no reads while the tab is hidden; one read on return, then on within the cap', async () => {
    spendNow = { run_status: 'pending', start_command: startCommand('pending') };
    await mount();
    await setHidden(true);
    const whileHidden = spendReads();
    await settle(60_000);
    expect(spendReads()).toBe(whileHidden);
    await setHidden(false);
    expect(spendReads()).toBe(whileHidden + 1); // read once right away
    await settle(5_000);
    expect(spendReads()).toBe(whileHidden + 2); // and go on
  });

  it('a read that comes back after the tab was hidden does not schedule the next one', async () => {
    spendNow = { run_status: 'pending', start_command: startCommand('pending') };
    await mount();
    holdSpend = { release: () => {} };
    await settle(5_000); // this read hangs
    await setHidden(true);
    const release = holdSpend!.release;
    holdSpend = null;
    release();
    await settle();
    const afterHide = spendReads();
    await settle(60_000);
    expect(spendReads()).toBe(afterHide);
  });

  it('no reads after unmount', async () => {
    spendNow = { run_status: 'pending', start_command: startCommand('pending') };
    await mount();
    await act(async () => { root.unmount(); });
    const atUnmount = spendReads();
    await settle(10 * 60_000);
    expect(spendReads()).toBe(atUnmount);
    root = createRoot(container); // afterEach unmounts again
  });

  it('a /spend that keeps failing still ends at the cap: the notice shows and the reads stop (Kadir 04:36Z)', async () => {
    spendNow = { run_status: 'running', start_command: startCommand('completed'), ...RUN_AD };
    await mount();
    await act(async () => { $('boost-pause-trigger')!.click(); });
    failSpend = true; // from the read right after the POST on, every /spend fails
    await act(async () => { $('boost-pause-confirm')!.click(); });
    await settle();
    expect($('boost-execution-waiting')?.textContent).toBe(cage.boostExecutionPausing);
    const first = spendReads();
    await settle(60_000);
    expect(spendReads() - first).toBe(12); // failed reads keep the 5 s cadence inside the cap
    await settle(2 * 60_000);
    expect($('boost-execution-cap-notice')?.textContent).toContain(cage.boostExecutionPauseCapSpend);
    expect($('boost-execution-waiting')).toBeNull();
    const capped = spendReads();
    await settle(10 * 60_000);
    expect(spendReads()).toBe(capped); // no endless reads after the cap
  });

  it('a start whose /spend keeps failing ends at 35 min with the start notice', async () => {
    spendNow = { run_status: 'pending', start_command: startCommand('pending') };
    await mount();
    failSpend = true;
    await settle(36 * 60_000);
    expect($('boost-execution-cap-notice')?.textContent).toBe(cage.boostExecutionStartCapNotice);
    const capped = spendReads();
    await settle(10 * 60_000);
    expect(spendReads()).toBe(capped);
  });

  it('the pause button is locked while its POST is out, like resume (Kadir 04:36Z)', async () => {
    spendNow = { run_status: 'running', start_command: startCommand('completed'), ...RUN_AD };
    await mount();
    await act(async () => { $('boost-pause-trigger')!.click(); });
    holdPost = { release: () => {} };
    await act(async () => { $('boost-pause-confirm')!.click(); });
    await settle();
    expect(($('boost-pause-trigger') as HTMLButtonElement).disabled).toBe(true); // submitting
    const release = holdPost!.release;
    holdPost = null;
    release();
    await settle();
    expect(($('boost-pause-trigger') as HTMLButtonElement).disabled).toBe(true); // then waiting for the pause
  });

  it('a tick while another read has not come back is skipped', async () => {
    spendNow = { run_status: 'running', start_command: startCommand('completed'), ...RUN_AD };
    await mount();
    await act(async () => { $('boost-pause-trigger')!.click(); });
    await act(async () => { $('boost-pause-confirm')!.click(); });
    await settle(); // waiting for the pause: the next tick is 5 s away
    const before = spendReads();
    holdSpend = { release: () => {} };
    await act(async () => { $('boost-spend-refresh-trigger')!.click(); }); // a read of its own that hangs
    await settle();
    expect(spendReads()).toBe(before + 1);
    await settle(5_000);
    expect(spendReads()).toBe(before + 1); // the tick came while that read was out: no second read on top
    const release = holdSpend!.release;
    holdSpend = null;
    release();
    await settle(5_000);
    expect(spendReads()).toBe(before + 2);
  });

  it('resume: reads until run_status is running; after 3 min the resume notice', async () => {
    spendNow = { run_status: 'paused', start_command: startCommand('completed'), ...RUN_AD };
    await mount();
    expect(spendReads()).toBe(1); // nothing to wait for: no polling
    await act(async () => { $('boost-resume-trigger')!.click(); });
    await settle();
    expect($('boost-execution-waiting')?.textContent).toBe(cage.boostExecutionResuming);
    await settle(3 * 60_000);
    expect($('boost-execution-cap-notice')?.textContent).toBe(cage.boostExecutionResumeCapNotice);
  });

  it('pause and resume buttons are locked while their command waits, and unlock when the wait ends', async () => {
    spendNow = { run_status: 'running', start_command: startCommand('completed'), ...RUN_AD };
    await mount();
    expect(($('boost-pause-trigger') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { $('boost-pause-trigger')!.click(); });
    await act(async () => { $('boost-pause-confirm')!.click(); });
    await settle();
    expect(($('boost-pause-trigger') as HTMLButtonElement).disabled).toBe(true); // no second pause while it waits
    await settle(3 * 60_000);
    expect(($('boost-pause-trigger') as HTMLButtonElement).disabled).toBe(false); // the cap ended the wait

    spendNow = { ...spendNow, run_status: 'paused' };
    await act(async () => { $('boost-spend-refresh-trigger')!.click(); });
    await settle();
    await act(async () => { $('boost-resume-trigger')!.click(); });
    await settle();
    expect(($('boost-resume-trigger') as HTMLButtonElement).disabled).toBe(true);
    spendNow = { ...spendNow, run_status: 'running' };
    await settle(5_000);
    expect(($('boost-pause-trigger') as HTMLButtonElement).disabled).toBe(false); // resumed: the wait is over
  });

  it('cap notices keep Korean words whole when they wrap (break-keep)', async () => {
    spendNow = { run_status: 'running', start_command: startCommand('completed'), ...RUN_AD };
    await mount();
    await act(async () => { $('boost-pause-trigger')!.click(); });
    await act(async () => { $('boost-pause-confirm')!.click(); });
    await settle(3 * 60_000);
    expect($('boost-execution-cap-notice')!.className).toContain('break-keep');
  });

  describe('pause after 3 min — the notice by ad channel', () => {
    async function pauseAndWaitOut(adChannel: string | null) {
      spendNow = { run_status: 'running', start_command: startCommand('completed'), ...RUN_AD, ad_channel: adChannel };
      await mount();
      await act(async () => { $('boost-pause-trigger')!.click(); });
      await act(async () => { $('boost-pause-confirm')!.click(); });
      await settle();
      expect($('boost-execution-waiting')?.textContent).toBe(cage.boostExecutionPausing);
      await settle(3 * 60_000);
      return $('boost-execution-cap-notice');
    }

    it('meta_ads: the money line, the campaign to look for and «stop in Ads Manager» opening that campaign', async () => {
      const notice = await pauseAndWaitOut('meta_ads');
      expect(notice?.textContent).toContain(cage.boostExecutionPauseCapSpend);
      expect($('boost-execution-cap-campaign')?.textContent).toBe(
        cage.boostNeedsCheckCampaignToFind.replace('{campaignName}', 'Boost 111_222'),
      );
      const link = $('boost-execution-ads-manager-link') as HTMLAnchorElement;
      expect(link.textContent).toContain(cage.boostExecutionStopInAdsManager);
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
      expect(link.href).toBe(
        'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1234567890&selected_campaign_ids=120200000001',
      );
    });

    it('ads_sandbox: only the refresh notice (it never spends)', async () => {
      const notice = await pauseAndWaitOut('ads_sandbox');
      expect(notice?.textContent).toBe(cage.boostExecutionPauseCapSandbox);
      expect(container.textContent).not.toContain(cage.boostExecutionPauseCapSpend);
      expect($('boost-execution-ads-manager-link')).toBeNull();
      expect($('boost-execution-cap-campaign')).toBeNull();
    });

    it('an unknown channel: the money line only (no name or link — the address is unknown)', async () => {
      const notice = await pauseAndWaitOut('tiktok_ads');
      expect(notice?.textContent).toBe(cage.boostExecutionPauseCapSpend);
      expect($('boost-execution-ads-manager-link')).toBeNull();
      expect($('boost-execution-cap-campaign')).toBeNull();
    });

    it('the notice clears on the next /spend response', async () => {
      await pauseAndWaitOut('meta_ads');
      spendNow = { ...spendNow, run_status: 'paused' };
      await act(async () => { $('boost-spend-refresh-trigger')!.click(); });
      await settle();
      expect($('boost-execution-cap-notice')).toBeNull();
    });
  });
});

describe('[SID:4416] adsManagerCampaignUrl', () => {
  it('opens the campaign, else the account, else the first screen', () => {
    expect(adsManagerCampaignUrl('1234567890', '120200000001')).toBe(
      'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1234567890&selected_campaign_ids=120200000001',
    );
    expect(adsManagerCampaignUrl('1234567890', null)).toBe('https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1234567890');
    expect(adsManagerCampaignUrl(null, '120200000001')).toBe('https://adsmanager.facebook.com/adsmanager/manage/campaigns');
  });
});
