'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Minus, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatKrw, AUTOMATION_PACK, STORAGE_PACK } from './pricing-data';

export type PackKind = 'automation' | 'storage';

function QuantityStepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (next: number) => void }) {
  return (
    <div className="inline-flex items-center overflow-hidden rounded-md border border-border">
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-none"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <span className="min-w-9 border-x border-border px-2 text-center text-sm font-semibold">{value}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-none"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function PricingPacks({ onBuyPack }: { onBuyPack: (kind: PackKind, quantity: number) => void }) {
  const t = useTranslations('pricingPlans');
  const [automationQty, setAutomationQty] = useState(1);
  const [storageQty, setStorageQty] = useState(1);

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-base font-semibold">{t('packsHeading')}</h3>
        <Badge variant="info">{t('packsBadge')}</Badge>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('packsDesc')}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">{t('automationPackTitle')}</h4>
            <Badge variant="info">{t('packMaxNote', { max: AUTOMATION_PACK.maxPacks })}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('automationPackDesc', { price: formatKrw(AUTOMATION_PACK.priceKrwPerPack) })}
          </p>
          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <QuantityStepper value={automationQty} min={1} max={AUTOMATION_PACK.maxPacks} onChange={setAutomationQty} />
            <span className="flex flex-col items-end">
              <span className="text-sm font-semibold">{formatKrw(AUTOMATION_PACK.priceKrwPerPack * automationQty)}</span>
              <span className="text-[10px] text-muted-foreground">{t('vatExcludedNote')}</span>
            </span>
            <Button variant="default" size="sm" className="bg-brand text-brand-foreground hover:bg-brand/90" onClick={() => onBuyPack('automation', automationQty)}>
              {t('buyPack')}
            </Button>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">{t('storagePackTitle')}</h4>
            <Badge variant="info">{t('packMaxNote', { max: STORAGE_PACK.maxPacks })}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('storagePackDesc', { price: formatKrw(STORAGE_PACK.priceKrwPerPack) })}
          </p>
          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <QuantityStepper value={storageQty} min={1} max={STORAGE_PACK.maxPacks} onChange={setStorageQty} />
            <span className="flex flex-col items-end">
              <span className="text-sm font-semibold">{formatKrw(STORAGE_PACK.priceKrwPerPack * storageQty)}</span>
              <span className="text-[10px] text-muted-foreground">{t('vatExcludedNote')}</span>
            </span>
            <Button variant="default" size="sm" className="bg-brand text-brand-foreground hover:bg-brand/90" onClick={() => onBuyPack('storage', storageQty)}>
              {t('buyPack')}
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">{t('packReassurance')}</div>
    </div>
  );
}
