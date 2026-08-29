'use client';

/**
 * story #3209(PR-1) — 웹 빌링 내역(주문별). 그라운딩 실측: 이 화면 자체가 아예 없었다
 * (payment-method-section.tsx는 "지금 등록된 카드"만 보여줄 뿐, "과거에 뭘 얼마나
 * 냈는지"를 보여줄 표면이 0 — 이 섹션이 그 갭). payment-method-section.tsx와 동형
 * 관례(canManage 게이팅 시 fetch 자체를 안 함·자기완결적 fetch/상태).
 *
 * receipt_url은 confirmed order에서만 값이 있다(billing_charge.py._confirm_with_ledger,
 * Toss payment 객체의 receipt.url — 공식 문서 확認·신규 발급/렌더 없이 Toss 호스팅
 * URL 그대로 링크). pending/failed는 링크 없이 상태만 노출 — "실패한 시도도 안 보이면
 * 사용자가 재시도 여부를 판단 못 한다"는 BE 엔드포인트 설계와 짝.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalLink } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { fetchWithAuth } from '@/lib/db/client';
import { formatKrw } from './pricing-data';

interface BillingOrderItem {
  order_id: string;
  created_at: string;
  amount_minor: number;
  currency: string;
  status: string;
  purpose: string;
  receipt_url: string | null;
}

function statusKey(status: string): 'orderHistoryStatusConfirmed' | 'orderHistoryStatusPending' | 'orderHistoryStatusFailed' | null {
  if (status === 'confirmed') return 'orderHistoryStatusConfirmed';
  if (status === 'pending') return 'orderHistoryStatusPending';
  if (status === 'failed') return 'orderHistoryStatusFailed';
  return null;
}

function purposeKey(purpose: string): 'orderHistoryPurposeCharge' | 'orderHistoryPurposePackPurchase' | null {
  if (purpose === 'charge') return 'orderHistoryPurposeCharge';
  if (purpose === 'pack_purchase') return 'orderHistoryPurposePackPurchase';
  return null;
}

// story #3209 유나 design:changes(2026-08-29) — 3상태가 전부 무색이면 실패가 성공과
// 시각 동일해진다("실패 시도도 보여준다"는 pending/failed 포함 명분과 자가당착). 결제
// 완료=success 색은 재량으로 payment-method-section.tsx 자매 섹션의 성공 배너와 맞춘다.
function statusColorClass(status: string): string {
  // 유나 재확認 정정(2026-08-29) — confirmed=text-success는 라이트 AA 미달(3.49:1<4.5,
  // 실측). PO 판정(유나 ①안) — confirmed 색 드롭, muted 원복. failed=destructive만
  // 유지(실패 스캔 목적은 그걸로 이미 달성, 완료는 기본값이라 색 불요).
  if (status === 'failed') return 'text-destructive';
  return 'text-muted-foreground';
}

export function OrderHistorySection({ canManage }: { canManage: boolean }) {
  const t = useTranslations('pricingPlans');
  const [orders, setOrders] = useState<BillingOrderItem[] | null | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    // payment-method-section.tsx와 동일 가드 — 무권한이면 조회 자체를 안 한다(BE도
    // 403이지만, 매 마운트마다 실패할 GET을 던지는 낭비+"내역이 있는지" 조용히 아는
    // 부작용을 FE 레벨에서 미리 막는다).
    if (!canManage) return;
    fetchWithAuth('/api/billing/orders', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((json: { data: BillingOrderItem[] }) => setOrders(json.data))
      .catch(() => {
        setOrders(null);
        setError(true);
      });
  }, [canManage]);

  if (!canManage || orders === undefined) return null;

  return (
    <div className="rounded-xl border border-border p-4">
      <p className="mb-2 text-sm font-semibold text-foreground">{t('orderHistoryTitle')}</p>

      {error && (
        <Alert variant="destructive" className="mb-2">
          <AlertDescription>{t('orderHistoryLoadError')}</AlertDescription>
        </Alert>
      )}

      {!error && (orders == null || orders.length === 0) && (
        <p className="text-sm text-muted-foreground">{t('orderHistoryEmpty')}</p>
      )}

      {!error && orders != null && orders.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            {/* 유나 design:changes — 스크린리더 컬럼 연결(a11y). 시각적으로는 기존 톤(연한
                muted 헤더)만 얹고 레이아웃엔 관여하지 않는다. */}
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="pb-1.5 pr-3 font-medium">{t('orderHistoryColDate')}</th>
                <th scope="col" className="pb-1.5 pr-3 font-medium">{t('orderHistoryColPurpose')}</th>
                <th scope="col" className="pb-1.5 pr-3 font-medium">{t('orderHistoryColAmount')}</th>
                <th scope="col" className="pb-1.5 pr-3 font-medium">{t('orderHistoryColStatus')}</th>
                <th scope="col" className="pb-1.5 font-medium">{t('orderHistoryColReceipt')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orders.map((order) => {
                const sKey = statusKey(order.status);
                const pKey = purposeKey(order.purpose);
                return (
                  <tr key={order.order_id}>
                    <td className="py-2 pr-3 text-muted-foreground">{order.created_at.slice(0, 10)}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{pKey ? t(pKey) : order.purpose}</td>
                    <td className="py-2 pr-3 font-medium text-foreground">{formatKrw(order.amount_minor)}</td>
                    <td className={`py-2 pr-3 ${statusColorClass(order.status)}`}>{sKey ? t(sKey) : order.status}</td>
                    <td className="py-2">
                      {order.receipt_url ? (
                        <a
                          href={order.receipt_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          {t('orderHistoryReceiptLink')}
                          <ExternalLink className="h-3 w-3" aria-hidden />
                        </a>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
