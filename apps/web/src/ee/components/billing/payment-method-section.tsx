'use client';

/**
 * story #2989 — 결제수단(빌링키) 표시+셀프서브 삭제. 이전엔 등록(POST)만 있고 「지금
 * 뭐가 등록돼 있는지」를 보여줄 표면 자체가 FE에 없었다(그라운딩 실측, `billing-tab.tsx`
 * 다른 섹션들과 독립된 파일로 분리 — 이 관심사만 자기완결적으로 fetch/상태를 갖는다).
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CreditCard, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  fetchBillingKey,
  deleteBillingKey,
  type BillingKeyInfo,
} from './billing-actions';

export function PaymentMethodSection({ canManage }: { canManage: boolean }) {
  const t = useTranslations('pricingPlans');
  const [key, setKey] = useState<BillingKeyInfo | null | undefined>(undefined);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'success' | 'blocked' | 'error'; tier?: string } | null>(null);

  const refetch = () => {
    void fetchBillingKey().then(setKey);
  };

  useEffect(() => {
    // 무권한(canManage=false)이면 조회조차 안 한다 — 신규 자체발견 회귀(테스트 작성 중):
    // 이 가드가 없으면 아래 렌더 게이트와 무관하게 mount마다 GET이 매번 나간다(무권한
    // 뷰어에게도 낭비 왕복 + 이 화면이 「등록됐는지 여부」를 조용히 아는 부작용).
    if (!canManage) return;
    refetch();
  }, [canManage]);

  // 로딩 중(undefined)이거나 무권한(canManage=false)이면 이 섹션 자체를 안 그린다 — 등록
  // 진입점(카드 등록하고 결제 버튼)도 canManage 게이팅을 이미 상위에서 하고 있어 동형.
  if (key === undefined || !canManage) return null;

  const handleDelete = async () => {
    setDeleting(true);
    setBanner(null);
    const outcome = await deleteBillingKey();
    setDeleting(false);
    setConfirmOpen(false);
    if (outcome.kind === 'deleted') {
      setBanner({ kind: 'success' });
      refetch();
    } else if (outcome.kind === 'blocked') {
      setBanner({ kind: 'blocked', tier: outcome.tier });
    } else {
      setBanner({ kind: 'error' });
    }
  };

  return (
    <div className="rounded-xl border border-border p-4">
      <p className="mb-2 text-sm font-semibold text-foreground">{t('paymentMethodTitle')}</p>

      {banner?.kind === 'success' && (
        <Alert variant="success" className="mb-2">
          <AlertDescription>{t('paymentMethodDeleteSuccess')}</AlertDescription>
        </Alert>
      )}
      {banner?.kind === 'blocked' && (
        <Alert variant="warning" className="mb-2">
          <AlertDescription>{t('paymentMethodDeleteBlocked', { tier: banner.tier ?? '' })}</AlertDescription>
        </Alert>
      )}
      {banner?.kind === 'error' && (
        <Alert variant="destructive" className="mb-2">
          <AlertDescription>{t('paymentMethodDeleteError')}</AlertDescription>
        </Alert>
      )}

      {key === null ? (
        <p className="text-sm text-muted-foreground">{t('paymentMethodNone')}</p>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm text-foreground">
            <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('paymentMethodMasked', {
              issuer: key.card_issuer_code ?? '',
              number: key.card_number_masked ?? '',
            })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            {t('paymentMethodDeleteButton')}
          </Button>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('paymentMethodDeleteConfirmTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t('paymentMethodDeleteConfirmBody')}</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              {t('paymentMethodDeleteCancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('paymentMethodDeleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
