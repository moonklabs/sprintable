'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';

/** AC4: 한도 초과 시 표시되는 업그레이드 모달 */
export function UpgradeModal({ meterType, onClose }: { meterType: string; onClose: () => void }) {
  const t = useTranslations('usage');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-backdrop">
      <div className="mx-4 w-full max-w-md rounded-xl bg-background p-6 shadow-xl">
        <h3 className="text-lg font-bold text-foreground">⚠️ {t('limitReached')}</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('limitDesc', { meter: t(meterType) })}
        </p>
        <div className="mt-4 flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-lg border py-2 text-sm text-foreground/80">
            {t('close')}
          </button>
          <Link href="/pricing" className="flex-1 rounded-lg bg-primary py-2 text-center text-sm font-medium text-primary-foreground hover:bg-primary/90">
            {t('upgrade')}
          </Link>
        </div>
      </div>
    </div>
  );
}
