// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { BoostRequestDialog } from './boost-request-dialog';
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

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider>;
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setNativeSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

const AD_CONNECTIONS_ROWS = [
  { id: 'conn-meta', channel: 'meta_ads', account_label: 'Meta 계정 A', account_id: 'act_1', status: 'active' },
  { id: 'conn-sandbox', channel: 'ads_sandbox', account_label: null, account_id: 'act_2', status: 'active' },
  // story #3806(그라운딩②) — threads는 boost 대상 광고 계정이 아니다(발행 채널일 뿐).
  { id: 'conn-threads', channel: 'threads', account_label: 'Threads', account_id: 'th_1', status: 'active' },
  // 비활성 연결은 목록에서 빠진다(요청해도 BE가 422로 거부할 값을 애초에 고를 수 없게).
  { id: 'conn-expired', channel: 'meta_ads', account_label: '만료됨', account_id: 'act_3', status: 'expired' },
];

describe('BoostRequestDialog — story #3806(Phase3·3-2 PR5, 유나 §절 §1)', () => {
  it('⭐meta_ads·ads_sandbox·active 연결만 select에 남고 나머지(threads·비활성)는 걸러진다', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: AD_CONNECTIONS_ROWS }));
    await act(async () => {
      root.render(wrap(
        <BoostRequestDialog open onOpenChange={() => {}} orgId="org-1" publicationId="pub-1" />,
      ));
    });
    await flush();

    const select = document.body.querySelector('[data-testid="boost-ad-connection-select"]') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toContain('Meta 계정 A');
    expect(optionLabels).toContain('act_2'); // account_label null → account_id 폴백
    expect(optionLabels).not.toContain('Threads');
    expect(optionLabels).not.toContain('만료됨');
  });

  it('연결된 광고 계정이 0건이면 select 대신 연결 안내 문구가 뜬다', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await act(async () => {
      root.render(wrap(
        <BoostRequestDialog open onOpenChange={() => {}} orgId="org-1" publicationId="pub-1" />,
      ));
    });
    await flush();

    expect(document.body.querySelector('[data-testid="boost-no-ad-connection"]')?.textContent)
      .toBe(koMessages.content.boostRequestNoAdConnection);
    expect(document.body.querySelector('[data-testid="boost-ad-connection-select"]')).toBeNull();
  });

  it('⭐제출 성공 — POST 본문이 예산 minor 변환·ISO 일정으로 조립되고, onRequested·onOpenChange(false)가 불린다', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: AD_CONNECTIONS_ROWS }));
    let closed = false;
    let requested = false;
    await act(async () => {
      root.render(wrap(
        <BoostRequestDialog
          open onOpenChange={(v) => { if (!v) closed = true; }} orgId="org-1" publicationId="pub-1"
          onRequested={() => { requested = true; }}
        />,
      ));
    });
    await flush();

    const select = document.body.querySelector('[data-testid="boost-ad-connection-select"]') as HTMLSelectElement;
    await act(async () => { setNativeSelectValue(select, 'conn-meta'); });
    const budget = document.body.querySelector('[data-testid="boost-budget-input"]') as HTMLInputElement;
    await act(async () => { setNativeInputValue(budget, '50000'); });
    const startsAt = document.body.querySelector('[data-testid="boost-starts-at-input"]') as HTMLInputElement;
    const endsAt = document.body.querySelector('[data-testid="boost-ends-at-input"]') as HTMLInputElement;
    const start = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
    const end = new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 16);
    await act(async () => { setNativeInputValue(startsAt, start); });
    await act(async () => { setNativeInputValue(endsAt, end); });

    mockedFetch.mockResolvedValueOnce(jsonResponse({
      data: { gate_id: 'gate-1', status: 'pending', reapproval_required: false },
    }, 201));

    const submit = document.body.querySelector('[data-testid="boost-submit"]') as HTMLButtonElement;
    await act(async () => { submit.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const submitCall = mockedFetch.mock.calls[1];
    expect(submitCall[0]).toBe('/api/organizations/org-1/publications/pub-1/boosts');
    const body = JSON.parse((submitCall[1] as RequestInit).body as string);
    expect(body.ad_connection_id).toBe('conn-meta');
    expect(body.budget_minor).toBe(50_000); // KRW exponent=0 → major===minor
    expect(body.currency).toBe('KRW');
    expect(body.objective).toBe('POST_ENGAGEMENT');
    expect(new Date(body.ends_at).getTime()).toBeGreaterThan(new Date(body.starts_at).getTime());
    expect(closed).toBe(true);
    expect(requested).toBe(true);
  });

  it('⭐서버 422(ADS_BUDGET_EXCEEDS_SEAL)는 매핑된 사람 문장으로 뜨고 다이얼로그는 안 닫힌다', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: AD_CONNECTIONS_ROWS }));
    let closed = false;
    await act(async () => {
      root.render(wrap(
        <BoostRequestDialog open onOpenChange={(v) => { if (!v) closed = true; }} orgId="org-1" publicationId="pub-1" />,
      ));
    });
    await flush();

    const select = document.body.querySelector('[data-testid="boost-ad-connection-select"]') as HTMLSelectElement;
    await act(async () => { setNativeSelectValue(select, 'conn-meta'); });
    const budget = document.body.querySelector('[data-testid="boost-budget-input"]') as HTMLInputElement;
    await act(async () => { setNativeInputValue(budget, '999999'); });
    const startsAt = document.body.querySelector('[data-testid="boost-starts-at-input"]') as HTMLInputElement;
    const endsAt = document.body.querySelector('[data-testid="boost-ends-at-input"]') as HTMLInputElement;
    await act(async () => { setNativeInputValue(startsAt, new Date(Date.now() + 86400000).toISOString().slice(0, 16)); });
    await act(async () => { setNativeInputValue(endsAt, new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 16)); });

    mockedFetch.mockResolvedValueOnce(jsonResponse({ error: { code: 'ADS_BUDGET_EXCEEDS_SEAL' } }, 422));

    const submit = document.body.querySelector('[data-testid="boost-submit"]') as HTMLButtonElement;
    await act(async () => { submit.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(document.body.querySelector('[data-testid="boost-submit-error"]')?.textContent)
      .toBe(koMessages.content.boostRequestErrorBudgetExceedsSeal);
    expect(closed).toBe(false);
  });

  it('종료 시각이 시작 시각보다 이르면(손댄 뒤) 제출이 막히고 순서 오류 문구가 뜬다', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: AD_CONNECTIONS_ROWS }));
    await act(async () => {
      root.render(wrap(<BoostRequestDialog open onOpenChange={() => {}} orgId="org-1" publicationId="pub-1" />));
    });
    await flush();

    const select = document.body.querySelector('[data-testid="boost-ad-connection-select"]') as HTMLSelectElement;
    await act(async () => { setNativeSelectValue(select, 'conn-meta'); });
    const budget = document.body.querySelector('[data-testid="boost-budget-input"]') as HTMLInputElement;
    await act(async () => { setNativeInputValue(budget, '10000'); });
    const startsAt = document.body.querySelector('[data-testid="boost-starts-at-input"]') as HTMLInputElement;
    const endsAt = document.body.querySelector('[data-testid="boost-ends-at-input"]') as HTMLInputElement;
    // 종료가 시작보다 이르다(둘 다 미래 — 「순서」만 틀림).
    await act(async () => { setNativeInputValue(startsAt, new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 16)); });
    await act(async () => { setNativeInputValue(endsAt, new Date(Date.now() + 86400000).toISOString().slice(0, 16)); });

    const submit = document.body.querySelector('[data-testid="boost-submit"]') as HTMLButtonElement;
    await act(async () => { submit.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    // POST가 아예 안 나갔다(초기 목록 조회 1건만) — 클라측에서 막혔다는 증거.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="boost-schedule-order-error"]')?.textContent)
      .toBe(koMessages.content.boostRequestScheduleOrderInvalid);
  });
});
