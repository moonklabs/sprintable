import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * E-VERIFY V0-S3 Lv0 — 보드 done 카드 신뢰 씰. 호출부가 `status==='done' && has_evidence`일 때만
 * 렌더해야 한다(positive 단방향 — 이 컴포넌트 자체는 조건을 재검사하지 않음). 완료 badge보다 낮은
 * 강도의 success 저강도 글리프 — 뱃지/배경/카운트 없이 단독 아이콘(유나 S4 §5 색 가이드).
 */
export function TrustSeal({ className }: { className?: string }) {
  const t = useTranslations('verify');
  return (
    <span className={cn('inline-flex shrink-0 items-center text-success/85', className)} title={t('provenCompletion')}>
      <Check className="h-3 w-3" strokeWidth={2.6} aria-hidden />
    </span>
  );
}
