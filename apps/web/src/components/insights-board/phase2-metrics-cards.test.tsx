// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { Phase2MetricsCards } from './phase2-metrics-cards';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const MEASURED_AND_UNMEASURED = {
  utm_attribution_rate: { value: 0.3, numerator: 30, denominator: 100, reason_code: null },
  comment_miss_rate: { value: null, numerator: 0, denominator: 0, reason_code: 'NO_COMMENT_DATA' },
  follow_up_creation_rate: { value: 0, numerator: 0, denominator: 5, reason_code: null },
  computed_at: '2026-09-07T00:00:00Z',
};

function stubFetch(data: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data }) })));
}

// story #3618(Phase2·BE+FE·실측) — 「0」과 「—」(미측정) 구분이 이 카드의 핵심 계약.
describe('Phase2MetricsCards — 값·미측정·0 구분(story #3618)', () => {
  it('값이 있으면 퍼센트+분자/분모를 보여준다', async () => {
    stubFetch(MEASURED_AND_UNMEASURED);
    await act(async () => { root.render(wrap(<Phase2MetricsCards orgId="org-1" />)); });
    await flush();

    const values = container.querySelectorAll('[data-testid="phase2-metric-value"]');
    expect(values[0].textContent).toBe('30%');
    expect(container.textContent).toContain('30 / 100');
  });

  it('value가 null이면 「—」와 사유 한 줄을 보여준다(원문 수치 0으로 오인 방지)', async () => {
    stubFetch(MEASURED_AND_UNMEASURED);
    await act(async () => { root.render(wrap(<Phase2MetricsCards orgId="org-1" />)); });
    await flush();

    const values = container.querySelectorAll('[data-testid="phase2-metric-value"]');
    expect(values[1].textContent).toBe('—');
    expect(container.textContent).toContain('채널이 원본 댓글 수를 아직 안 줬습니다');
  });

  it('value가 0이면 「—」가 아니라 "0%"를 그대로 보여준다(측정은 됐고 실제로 0)', async () => {
    stubFetch(MEASURED_AND_UNMEASURED);
    await act(async () => { root.render(wrap(<Phase2MetricsCards orgId="org-1" />)); });
    await flush();

    const values = container.querySelectorAll('[data-testid="phase2-metric-value"]');
    expect(values[2].textContent).toBe('0%');
    expect(values[2].textContent).not.toBe('—');
  });

  it('기간 토글(7일→30일)을 누르면 새 days로 다시 fetch한다', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({ ok: true, json: async () => ({ data: MEASURED_AND_UNMEASURED }) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<Phase2MetricsCards orgId="org-1" />)); });
    await flush();

    const btn30 = container.querySelector('[data-testid="phase2-days-30"]') as HTMLButtonElement;
    await act(async () => { btn30.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes('days=30'))).toBe(true);
  });

  it('조회 실패 시 에러 문구를 보여준다(에러 표면·크래시 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    await act(async () => { root.render(wrap(<Phase2MetricsCards orgId="org-1" />)); });
    await flush();

    expect(container.querySelector('[data-testid="phase2-metrics-error"]')).not.toBeNull();
  });
});
