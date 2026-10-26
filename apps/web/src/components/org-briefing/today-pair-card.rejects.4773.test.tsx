// @vitest-environment jsdom
//
// story 4773 (AC3) — the card's read can never be a reason for a line or for a crash: if the read itself were to reject (it does not today — every await inside
// `readStartableKeyed` is inside its own try/catch — but the card does not rely on that), the card draws nothing and nothing is left unhandled.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
const readStartableKeyed = vi.hoisted(() => vi.fn());
vi.mock('@/lib/phone-start', () => ({ readStartableKeyed: (...args: unknown[]) => readStartableKeyed(...args) }));

const { TodayPairCard } = await import('./today-pair-card');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useDashboardContextMock.mockReturnValue({ projectId: 'p1', inShell: true });
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

async function draw() {
  await act(async () => {
    root.render(
      <PhoneBridgeContext.Provider value={{ inPhoneApp: true, phoneCall: async () => ({ id: 'w1', ok: true }) }}>
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><TodayPairCard /></NextIntlClientProvider>
      </PhoneBridgeContext.Provider>,
    );
  });
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
}

describe('[SID:4773] TodayPairCard — a read that rejects', () => {
  it('draws nothing (and leaves no unhandled rejection: the run fails on one)', async () => {
    readStartableKeyed.mockRejectedValue(new Error('read blew up'));
    await draw();
    expect(readStartableKeyed).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="today-pair-card"]')).toBeNull(); // a rejected read counted as «unpaired» → fails
  });

  it('control: the same mock answering «paired with nothing» draws the card (so the test above is not «never draws»)', async () => {
    readStartableKeyed.mockResolvedValue({ kind: 'no_phone' });
    await draw();
    expect(host.querySelector('[data-testid="today-pair-card"]')).not.toBeNull();
  });
});
