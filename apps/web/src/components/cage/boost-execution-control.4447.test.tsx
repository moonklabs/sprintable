// @vitest-environment jsdom
//
// story #4447 — the boost card's states come from the server's contract (BOOST_RUN_STATUSES · COMMAND_STATUSES ·
// COMMAND_FAILURE_KINDS, generated from backend/app/services/ads_boost_states.py), and every cell of the state table says what is
// true. Before: any run status outside running/paused — a pending pause, or a value the card did not know — fell into the
// «not started» branch and offered «홍보 시작»; a start that failed (not_sent · transient · connection · paused) showed no line,
// and «홍보 시작» only returned the same dead command (live S6, 2026-10-01). Copy: Yuna 02:20Z.
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
  // story #4458 — useFlatHref (the post link) reads the shell's project
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
const posts = (suffix: string) => mockedFetch.mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && init);
const cmd = (status: string, failureKind: string | null, retryable: boolean, errorCode: string | null = null) =>
  ({ id: 'cmd-1', status, failure_kind: failureKind, error_code: errorCode, campaign_name: null, retryable });
const text = () => container.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-01T03:00:00Z'));
  spendNow = { run_status: null, start_command: null };
  mockedFetch.mockReset();
  mockedFetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/spend') && !init) return jsonResponse({ data: spendNow });
    return jsonResponse({ data: { id: 'cmd-1', status: 'pending' } }, 200);
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
        />
      </NextIntlClientProvider>,
    );
  });
  await settle();
}

describe('BoostExecutionControl — the state table (#4447)', () => {
  it('① a run status the card does not know: «홍보 상태를 알 수 없어요» · no start button', async () => {
    spendNow = { run_status: 'ended', start_command: cmd('completed', null, false) };
    await mount();
    expect(text()).toContain(cage.boostStateUnknown);
    expect($('boost-start-trigger')).toBeNull();
  });

  it('① a command status or failure kind the card does not know: the same safe cell', async () => {
    spendNow = { run_status: 'pending', start_command: cmd('mystery', null, false) };
    await mount();
    expect(text()).toContain(cage.boostStateUnknown);
    expect($('boost-start-trigger')).toBeNull();
    await act(async () => { root.unmount(); }); root = createRoot(container);
    spendNow = { run_status: 'pending', start_command: cmd('dead_letter', 'brand_new_kind', true) };
    await mount();
    expect(text()).toContain(cage.boostStateUnknown);
    expect($('boost-start-trigger')).toBeNull();
  });

  it('② pause_pending: «중지 중…» in the running shape · no start · after the 3 min cap the sandbox refresh notice', async () => {
    spendNow = { run_status: 'pause_pending', start_command: cmd('completed', null, false), ad_channel: 'ads_sandbox', campaign_id: 'c-1', campaign_name: 'Boost x' };
    await mount();
    expect(text()).toContain(cage.boostExecutionPausing);
    expect($('boost-start-trigger')).toBeNull();
    expect($('boost-pause-trigger')).toBeNull(); // a pause is already requested
    expect($('boost-resume-trigger')).toBeNull();
    await settle(3 * 60_000 + 10_000);
    expect($('boost-execution-cap-notice')?.textContent).toBe(cage.boostExecutionPauseCapSandbox);
    expect($('boost-start-trigger')).toBeNull();
  });

  it('② pause_pending on Meta ads: after the cap the money line and the Ads Manager link (4416 rule)', async () => {
    spendNow = { run_status: 'pause_pending', start_command: cmd('completed', null, false), ad_channel: 'meta_ads', campaign_id: '120200000001', ad_account_id: '1234567890', campaign_name: 'Boost 111_222' };
    await mount();
    await settle(3 * 60_000 + 10_000);
    expect(text()).toContain(cage.boostExecutionPauseCapSpend);
    expect($('boost-execution-ads-manager-link')).not.toBeNull();
    expect($('boost-start-trigger')).toBeNull();
  });

  it('③ not_sent (retryable): the line + «다시 시도» → the retry endpoint, never «홍보 시작»', async () => {
    spendNow = { run_status: 'pending', start_command: cmd('dead_letter', 'not_sent', true) };
    await mount();
    expect(text()).toContain(cage.boostStartFailedNotSent);
    expect($('boost-start-trigger')).toBeNull();
    await act(async () => { $('boost-start-failed-retry')!.click(); });
    await settle();
    const calls = posts('/publication-commands/cmd-1/retry');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String((calls[0]![1] as RequestInit).body))).toEqual({ confirmed_no_campaign: false });
    expect(posts('/start')).toHaveLength(0);
  });

  it('③ transient (retries ran out, retryable): its line + «다시 시도»', async () => {
    spendNow = { run_status: 'pending', start_command: cmd('dead_letter', 'transient', true) };
    await mount();
    expect(text()).toContain(cage.boostStartFailedTransient);
    expect($('boost-start-failed-retry')).not.toBeNull();
    expect($('boost-start-trigger')).toBeNull();
  });

  it('③ connection (blocked), not retryable: the line with the «연결 확인» link · no tail · no button · no start', async () => {
    spendNow = { run_status: 'pending', start_command: cmd('blocked', 'connection', false) };
    await mount();
    const line = $('boost-start-failed');
    expect(line?.textContent).toContain('광고 계정 연결이 끊겨 시작하지 못했어요');
    expect(line?.querySelector('a')?.getAttribute('href')).toBe('/ws/proj/organization/channels');
    expect(line?.textContent).toBe(cage.boostStartFailedConnection.replace(/<\/?link>/g, ''));
    expect($('boost-start-failed-retry')).toBeNull();
    expect($('boost-start-trigger')).toBeNull();
  });

  // Qadir 4870 ② — the server's `retryable` alone decides the button: a connection-blocked start the server lets a person retry
  // (after reconnecting · the server does not re-queue it by itself) had no button because the card re-filtered by kind.
  it('③ connection (blocked) and the server says retryable: the line with the «연결 확인» link and the retry tail · «다시 시도» → the retry endpoint', async () => {
    spendNow = { run_status: 'pending', start_command: cmd('blocked', 'connection', true) };
    await mount();
    expect($('boost-start-failed')?.textContent).toBe(cage.boostStartFailedConnectionRetry.replace(/<\/?link>/g, ''));
    expect($('boost-start-failed')?.querySelector('a')).not.toBeNull();
    expect($('boost-start-failed-retry')).not.toBeNull();
    await act(async () => { $('boost-start-failed-retry')!.click(); });
    await settle();
    expect(posts('/cmd-1/retry')).toHaveLength(1);
  });

  it('③ paused (the org paused external publishing): the reason only · no button (the server re-queues it)', async () => {
    spendNow = { run_status: 'pending', start_command: cmd('blocked', 'paused', false) };
    await mount();
    expect(text()).toContain(cage.boostStartFailedPaused);
    expect($('boost-start-failed-retry')).toBeNull();
    expect($('boost-start-trigger')).toBeNull();
  });

  // Yuna 03:03Z — «— 다시 시도해 주세요» only where the button is: without it the line stops at the fact.
  it.each([
    ['not_sent', 'boostStartFailedNotSentNoRetry', 'boostStartFailedNotSent'],
    ['transient', 'boostStartFailedTransientNoRetry', 'boostStartFailedTransient'],
  ] as const)('③ %s and the server says this person cannot retry: the line without the retry tail, no button', async (kind, noRetryKey, retryKey) => {
    spendNow = { run_status: 'pending', start_command: cmd('dead_letter', kind, false) };
    await mount();
    expect($('boost-start-failed')?.textContent).toBe(cage[noRetryKey]);
    expect(text()).not.toContain(cage[retryKey]);
    expect($('boost-start-failed-retry')).toBeNull();
    expect($('boost-start-trigger')).toBeNull();
  });

  it('④ a failed or blocked start without a known way on: «이 홍보는 지금 시작할 수 없어요.» · no start', async () => {
    spendNow = { run_status: 'pending', start_command: cmd('failed', null, false) };
    await mount();
    expect(text()).toContain(cage.boostStartBlocked);
    expect($('boost-start-trigger')).toBeNull();
  });

  // Qadir 4870 ① — a start the worker stopped before any call (`blocked_unapproved`) says why and what next, by its reason code;
  // never «unknown» and never a retry (approving again makes a new command).
  it.each([
    ['ADS_BOOST_GATE_NOT_APPROVED', 'boostStartBlockedApprovalGone'],
    ['ADS_BOOST_ORIGINAL_PUBLICATION_MISSING', 'boostStartBlockedPostMissing'],
    ['ADS_BOOST_GATE_MISSING', 'boostStartBlocked'],
    ['ADS_BOOST_NOT_STARTED_AT_PROVIDER', 'boostStartBlocked'], // a pause/resume code — never expected here, so the fallback
    [null, 'boostStartBlocked'],
  ] as const)('④ blocked_unapproved · %s: its line · no retry · no start', async (code, key) => {
    spendNow = { run_status: 'pending', start_command: cmd('blocked_unapproved', null, false, code) };
    await mount();
    expect($('boost-start-failed')?.textContent).toBe(cage[key]);
    expect(text()).not.toContain(cage.boostStateUnknown);
    expect($('boost-start-failed-retry')).toBeNull();
    expect($('boost-start-trigger')).toBeNull();
  });

  it.each([
    ['ADS_BOOST_CONNECTION_UNAVAILABLE', 'boostStartFailedConnection'], // Yuna — the same line as the connection failure (same fact)
    ['ADS_BOOST_ORIGIN_CONNECTION_MISSING', 'boostStartBlockedOriginConnection'],
  ] as const)('④ blocked_unapproved · %s: its line with the channel-connections link · no retry', async (code, key) => {
    spendNow = { run_status: 'pending', start_command: cmd('blocked_unapproved', null, false, code) };
    await mount();
    expect($('boost-start-failed')?.textContent).toBe(cage[key].replace(/<\/?link>/g, ''));
    expect($('boost-start-failed')?.querySelector('a')?.getAttribute('href')).toBe('/ws/proj/organization/channels');
    expect($('boost-start-failed-retry')).toBeNull();
  });

  it('④ a voided start (its approval was replaced) is no start at all: «홍보 시작» from the valid approval', async () => {
    spendNow = { run_status: 'pending', start_command: cmd('voided', null, false) };
    await mount();
    expect($('boost-start-trigger')).not.toBeNull();
    expect(text()).not.toContain(cage.boostStateUnknown);
  });

  it('a start that is just queued still reads «시작하는 중…» with the button locked (4416 unchanged)', async () => {
    spendNow = { run_status: 'pending', start_command: cmd('pending', null, false) };
    await mount();
    expect(text()).toContain(cage.boostExecutionStarting);
  });

  // story #4458 (PO 08:13Z ②) — a campaign made on another budget (a re-seal during its create) is not switched on: the card says
  // why and offers no retry (it would stop the same way every time)
  it('needs_check · ADS_BOOST_CREATED_BUDGET_DIFFERS: the facts only — created budget · approved budget · no link · no retry · no start', async () => {
    // PO 10:56Z — re-seals only lower the budget, so «request again at that budget» is never a way on: no link at all
    spendNow = { run_status: 'pending', start_command: cmd('dead_letter', 'needs_check', false, 'ADS_BOOST_CREATED_BUDGET_DIFFERS'), created_budget_minor: 100_000 };
    await mount();
    const line = $('boost-needs-check-reason')!;
    expect(line.textContent).toContain('100,000원');
    expect(line.textContent).toContain('광고비는 나가지 않아요'); // Yuna 11:00Z — what the person needs now: no money goes out
    expect(line.querySelector('a')).toBeNull();
    expect($('boost-needs-check-retry-trigger')).toBeNull();
    expect($('boost-start-trigger')).toBeNull();
  });
});
