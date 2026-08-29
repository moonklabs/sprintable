// @vitest-environment jsdom
//
// story #3209(PR-1) — OrderHistorySection 실 렌더 검증. 이전엔 결제 내역을 보여줄
// 표면 자체가 없었다(그라운딩 실측) — 이 파일이 그 신규 표면의 회귀가드.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { OrderHistorySection } from './order-history-section';
import { fetchWithAuth } from '@/lib/db/client';

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

async function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(wrap(node)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.mocked(fetchWithAuth).mockReset();
});

describe('OrderHistorySection(story #3209)', () => {
  it('canManage=false면 아무것도 안 그린다(payment-method-section.tsx와 동형 게이팅)', async () => {
    await mount(<OrderHistorySection canManage={false} />);
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('내역이 없으면 빈 상태 문구를 보여준다(지어내지 않음)', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as Response);
    await mount(<OrderHistorySection canManage={true} />);
    expect(container.textContent).toContain(koMessages.pricingPlans.orderHistoryEmpty);
  });

  it('confirmed 주문은 영수증 링크(receipt_url)를 새 탭으로 연다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          order_id: 'order-1', created_at: '2026-08-29T10:00:00Z', amount_minor: 49000,
          currency: 'KRW', status: 'confirmed', purpose: 'charge',
          receipt_url: 'https://dashboard.tosspayments.com/receipt/abc123',
        }],
      }),
    } as Response);
    await mount(<OrderHistorySection canManage={true} />);
    expect(container.textContent).toContain('49,000원');
    expect(container.textContent).toContain(koMessages.pricingPlans.orderHistoryStatusConfirmed);
    const link = container.querySelector('a[href="https://dashboard.tosspayments.com/receipt/abc123"]');
    expect(link).toBeTruthy();
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('receipt_url이 없는 주문(pending/failed)은 상태만 뜨고 영수증 링크가 없다 — uuid 등 지어낸 링크 금지', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          order_id: 'order-2', created_at: '2026-08-29T10:00:00Z', amount_minor: 49000,
          currency: 'KRW', status: 'failed', purpose: 'charge', receipt_url: null,
        }],
      }),
    } as Response);
    await mount(<OrderHistorySection canManage={true} />);
    expect(container.textContent).toContain(koMessages.pricingPlans.orderHistoryStatusFailed);
    expect(container.querySelector('a')).toBeNull();
  });

  // story #3209 유나 design:changes(2026-08-29) — 3상태 전부 무색이면 실패=성공 시각
  // 구분 불가("실패도 보여준다"는 명분과 자가당착) 지적 반영. 유나 재확認 정정 —
  // confirmed=text-success는 라이트 AA 미달(3.49:1<4.5 실측)이라 PO 판정으로 드롭,
  // muted 원복(failed=destructive만 유지).
  it('실패 상태는 text-destructive, 완료 상태는 muted(색 없음)다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { order_id: 'order-3', created_at: '2026-08-29T10:00:00Z', amount_minor: 49000, currency: 'KRW', status: 'failed', purpose: 'charge', receipt_url: null },
          { order_id: 'order-4', created_at: '2026-08-28T10:00:00Z', amount_minor: 49000, currency: 'KRW', status: 'confirmed', purpose: 'charge', receipt_url: 'https://dashboard.tosspayments.com/receipt/xyz' },
        ],
      }),
    } as Response);
    await mount(<OrderHistorySection canManage={true} />);
    const failedCell = Array.from(container.querySelectorAll('td')).find((td) => td.textContent === koMessages.pricingPlans.orderHistoryStatusFailed);
    const confirmedCell = Array.from(container.querySelectorAll('td')).find((td) => td.textContent === koMessages.pricingPlans.orderHistoryStatusConfirmed);
    expect(failedCell?.className).toContain('text-destructive');
    expect(confirmedCell?.className).toContain('text-muted-foreground');
    expect(confirmedCell?.className).not.toContain('text-success');
  });

  it('표에 컬럼 헤더(thead)가 있다 — 스크린리더 컬럼 연결', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ order_id: 'order-5', created_at: '2026-08-29T10:00:00Z', amount_minor: 49000, currency: 'KRW', status: 'confirmed', purpose: 'charge', receipt_url: null }],
      }),
    } as Response);
    await mount(<OrderHistorySection canManage={true} />);
    const headers = Array.from(container.querySelectorAll('th'));
    expect(headers.length).toBe(5);
    expect(headers.every((h) => h.getAttribute('scope') === 'col')).toBe(true);
  });

  it('조회 실패(non-ok)면 에러 문구를 보여준다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    await mount(<OrderHistorySection canManage={true} />);
    expect(container.textContent).toContain(koMessages.pricingPlans.orderHistoryLoadError);
  });
});
