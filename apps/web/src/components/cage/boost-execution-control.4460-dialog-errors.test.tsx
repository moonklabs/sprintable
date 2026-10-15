// @vitest-environment jsdom
//
// story #4460 (Yuna 00:38Z CHANGES · PO: every confirmation in this file) — a refused action whose confirmation stays open says so
// inside that dialog, above its buttons (role=alert). Before: the line went to the card under the overlay, and the money button
// looked as if it did nothing. jsdom does not know the overlay covers the card, so each test looks inside the dialog itself.
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
let refuse: (url: string) => Response | 'throw' | null;

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), headers: { get: () => null } }) as unknown as Response;
const $ = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const click = async (id: string) => { await act(async () => { $(id)!.click(); }); await flush(); };

const completedStart = { id: 'cmd-1', status: 'completed', failure_kind: null, error_code: null, campaign_name: null, retryable: false };
const running = { run_status: 'running', start_command: completedStart, gate_status: 'approved', can_cancel: true };
const needsCheck = {
  run_status: 'pending', gate_status: 'approved',
  start_command: {
    id: 'cmd-1', status: 'dead_letter', failure_kind: 'needs_check', error_code: 'ADS_BOOST_CREATE_OUTCOME_UNKNOWN',
    campaign_name: 'Boost 1_2', retryable: true,
  },
};

beforeEach(() => {
  spendNow = running;
  refuse = () => null;
  mockedFetch.mockReset();
  mockedFetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/spend') && !init) return jsonResponse({ data: spendNow });
    const r = refuse(String(url));
    if (r === 'throw') throw new TypeError('Failed to fetch');
    if (r) return r;
    return jsonResponse({ data: { id: 'cmd-2', status: 'pending' } });
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

/** The dialog is still open and says the refusal inside itself, as an alert above its buttons. */
function expectErrorInside(dialogId: string, message: string) {
  const dialog = $(dialogId);
  expect(dialog).not.toBeNull();
  const line = dialog!.querySelector('[data-testid="boost-dialog-error"]');
  expect(line?.textContent).toBe(message);
  expect(line?.getAttribute('role')).toBe('alert');
  const footerButton = dialog!.querySelector('button:last-of-type');
  expect(line!.compareDocumentPosition(footerButton!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe('[SID:4460] a refusal inside an open confirmation is said inside it', () => {
  it('① 홍보 취소 refused (403): the server\'s words inside the cancel dialog', async () => {
    refuse = (u) => (u.endsWith('/cancel') ? jsonResponse({ error: { message: '요청한 사람이나 관리자만 취소할 수 있어요.' } }, 403) : null);
    await mount();
    await click('boost-cancel-trigger');
    await click('boost-cancel-confirm');
    expectErrorInside('boost-cancel-confirm-dialog', '요청한 사람이나 관리자만 취소할 수 있어요.');
  });

  it('① 홍보 취소 when the network fails: the generic line inside the cancel dialog', async () => {
    refuse = (u) => (u.endsWith('/cancel') ? 'throw' : null);
    await mount();
    await click('boost-cancel-trigger');
    await click('boost-cancel-confirm');
    expectErrorInside('boost-cancel-confirm-dialog', cage.boostExecutionActionError);
  });

  it('② 중지 refused: inside the pause dialog', async () => {
    refuse = (u) => (u.endsWith('/pause') ? jsonResponse({ error: { message: 'x' } }, 409) : null);
    await mount();
    await click('boost-pause-trigger');
    await click('boost-pause-confirm');
    expectErrorInside('boost-pause-confirm-dialog', cage.boostExecutionActionError);
  });

  it('③ 시작 refused: inside the start dialog', async () => {
    spendNow = { run_status: null, start_command: null, gate_status: 'approved' };
    refuse = (u) => (u.endsWith('/start') ? jsonResponse({ error: { message: 'x' } }, 500) : null);
    await mount();
    await click('boost-start-trigger');
    await click('boost-start-confirm');
    expectErrorInside('boost-start-confirm-dialog', cage.boostExecutionActionError);
  });

  it('④ 확인 뒤 다시 시도 refused: inside the needs-check dialog', async () => {
    spendNow = needsCheck;
    refuse = (u) => (u.endsWith('/retry') ? jsonResponse({ error: { message: 'x' } }, 500) : null);
    await mount();
    await click('boost-needs-check-retry-trigger');
    await click('boost-needs-check-confirm-checklist');
    await click('boost-needs-check-confirm');
    expectErrorInside('boost-needs-check-dialog', cage.boostExecutionActionError);
  });

  it('⑤ 이미 있는 캠페인 연결 refused: inside the adopt dialog', async () => {
    spendNow = needsCheck;
    refuse = (u) => (u.endsWith('/adopt-existing') ? jsonResponse({ error: { message: 'x' } }, 500) : null);
    await mount();
    await click('boost-adopt-trigger');
    await click('boost-adopt-confirm');
    expectErrorInside('boost-adopt-dialog', cage.boostExecutionActionError);
  });

  it('a confirmation opens clean: an earlier refusal is not carried into the next dialog', async () => {
    refuse = (u) => (u.endsWith('/pause') ? jsonResponse({ error: { message: 'x' } }, 500) : null);
    await mount();
    await click('boost-pause-trigger');
    await click('boost-pause-confirm');
    expectErrorInside('boost-pause-confirm-dialog', cage.boostExecutionActionError);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await flush();
    await click('boost-cancel-trigger');
    expect($('boost-cancel-confirm-dialog')?.querySelector('[data-testid="boost-dialog-error"]')).toBeNull();
  });
});
