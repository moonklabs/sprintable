// @vitest-environment jsdom
//
// story #3979(자리 옮김 ②) — 일별 광고비 지출 막대(PaidSpendDailySeriesCard,
// 기존 그대로)가 「광고 상한」 카드 펼침 안으로. 기본 접힘 — 펼치기 전엔 그
// 카드 자체가 마운트되지 않는다(불필요한 fetch 방지), 펼치면 나타난다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AdsCapCard } from './ads-cap-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ data: { currency: 'KRW', points: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('AdsCapCard(story #3979)', () => {
  it('⭐기본 접힘 — 펼치기 전엔 차트 카드가 마운트되지 않는다', async () => {
    await act(async () => { root.render(wrap(<AdsCapCard orgId="org-1" />)); });
    expect(container.querySelector('[data-testid="ads-cap-card-body"]')).toBeNull();
    expect(container.querySelector('[data-testid="ads-cap-card-toggle"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('⭐토글 클릭하면 펼쳐져 기존 PaidSpendDailySeriesCard가 그대로 나타난다', async () => {
    await act(async () => { root.render(wrap(<AdsCapCard orgId="org-1" />)); });
    const toggle = container.querySelector('[data-testid="ads-cap-card-toggle"]') as HTMLElement;
    await act(async () => { toggle.click(); });
    await flush();
    expect(container.querySelector('[data-testid="ads-cap-card-body"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paid-spend-daily-series-card"], [data-testid="paid-spend-daily-series-card-loading"]')).not.toBeNull();
  });
});
