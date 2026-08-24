// @vitest-environment jsdom
//
// story #2989 — PaymentMethodSection 실 렌더 검증. 이전엔 등록된 결제수단을 보여줄
// 표면 자체가 없었다(그라운딩 실측) — 이 파일이 그 신규 표면의 회귀가드.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { PaymentMethodSection } from './payment-method-section';
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

describe('PaymentMethodSection(story #2989)', () => {
  it('canManage=false면 아무것도 안 그린다(등록 진입점과 동형 게이팅)', async () => {
    await mount(<PaymentMethodSection canManage={false} />);
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('등록된 카드가 없으면 "등록된 결제수단이 없습니다"를 보여준다(지어내지 않음)', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, json: async () => ({ data: null }) } as Response);
    await mount(<PaymentMethodSection canManage={true} />);
    expect(container.textContent).toContain(koMessages.pricingPlans.paymentMethodNone);
  });

  it('등록된 카드가 있으면 마스킹 정보+삭제 버튼을 보여준다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { org_id: 'org-1', status: 'active', card_issuer_code: '91', card_number_masked: '54258677****176*', card_type: 'CREDIT' } }),
    } as Response);
    await mount(<PaymentMethodSection canManage={true} />);
    expect(container.textContent).toContain('54258677****176*');
    const deleteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.pricingPlans.paymentMethodDeleteButton));
    expect(deleteBtn).toBeTruthy();
  });

  it('삭제 확認 다이얼로그에서 삭제 클릭 → DELETE 호출 → 성공 시 완료 배너+목록 갱신', async () => {
    // 첫 GET(마운트)만 카드 있음, DELETE 성공, 그 後 재조회 GET은 없음(재조회로 목록 갱신 확認).
    let getCount = 0;
    vi.mocked(fetchWithAuth).mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return { ok: true, json: async () => ({ data: { deleted: true } }) } as Response;
      }
      getCount += 1;
      if (getCount === 1) {
        return { ok: true, json: async () => ({ data: { org_id: 'org-1', status: 'active', card_issuer_code: '91', card_number_masked: '54258677****176*', card_type: 'CREDIT' } }) } as Response;
      }
      return { ok: true, json: async () => ({ data: null }) } as Response;
    });

    await mount(<PaymentMethodSection canManage={true} />);
    const openBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.pricingPlans.paymentMethodDeleteButton));
    await act(async () => { openBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === koMessages.pricingPlans.paymentMethodDeleteConfirm);
    await act(async () => { confirmBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain(koMessages.pricingPlans.paymentMethodDeleteSuccess);
    expect(container.textContent).toContain(koMessages.pricingPlans.paymentMethodNone);
  });

  it('409(active_subscription_blocks_revoke)면 tier+실 종료일을 포함한 차단 배너를 보여준다(P3 서버강제)', async () => {
    // PO 재지적(2026-08-24, PR#3423 리뷰, 유나 관찰) — 해지는 예약형이라 "해지 후 다시
    // 시도" 안내는 거짓. 배너가 실 종료일(current_period_end)을 찍어야 한다.
    vi.mocked(fetchWithAuth).mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return {
          ok: false, status: 409,
          json: async () => ({
            data: null,
            error: { code: 'active_subscription_blocks_revoke', message: 'x', tier: 'starter', current_period_end: '2026-09-24T00:00:00+00:00' },
          }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({ data: { org_id: 'org-1', status: 'active', card_issuer_code: '91', card_number_masked: '54258677****176*', card_type: 'CREDIT' } }) } as Response;
    });

    await mount(<PaymentMethodSection canManage={true} />);
    const openBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.pricingPlans.paymentMethodDeleteButton));
    await act(async () => { openBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === koMessages.pricingPlans.paymentMethodDeleteConfirm);
    await act(async () => { confirmBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('starter');
    expect(container.textContent).toContain('2026-09-24');
    expect(container.textContent).not.toContain('해지 후 다시 시도');
    // 카드는 여전히 남아있다(BE가 삭제 자체를 거부했으므로 목록에서 안 사라져야 함).
    expect(container.textContent).toContain('54258677****176*');
  });

  it('409 응답에 current_period_end가 없으면 날짜 없는 폴백 문구를 보여준다', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return {
          ok: false, status: 409,
          json: async () => ({
            data: null,
            error: { code: 'active_subscription_blocks_revoke', message: 'x', tier: 'team', current_period_end: null },
          }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({ data: { org_id: 'org-1', status: 'active', card_issuer_code: '91', card_number_masked: '54258677****176*', card_type: 'CREDIT' } }) } as Response;
    });

    await mount(<PaymentMethodSection canManage={true} />);
    const openBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.pricingPlans.paymentMethodDeleteButton));
    await act(async () => { openBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === koMessages.pricingPlans.paymentMethodDeleteConfirm);
    await act(async () => { confirmBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain(koMessages.pricingPlans.paymentMethodDeleteBlocked.replace('{tier}', 'team'));
  });
});
