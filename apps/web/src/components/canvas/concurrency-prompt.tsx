import { useTranslations } from 'next-intl';

interface ConcurrencyPromptProps {
  authorName: string;
  version: number;
  onView: () => void;
  onMergeOver: () => void;
  className?: string;
}

/**
 * E-CANVAS C3 §3 — 동시 편집 충돌 프롬프트. 파괴적 덮어쓰기 금지·조용한 선택지만
 * 제시(§4 감시-게이트: "뺏김/경쟁" 톤 금지 — info 조력 톤, 협업 프레임).
 */
export function ConcurrencyPrompt({ authorName, version, onView, onMergeOver, className }: ConcurrencyPromptProps) {
  const t = useTranslations('canvas');
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-[11px]">
        <span className="text-info">{t('concurrencyArrived', { name: authorName, version })}</span>
        <span className="flex shrink-0 gap-1.5">
          <button type="button" onClick={onView} className="rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:bg-muted">
            {t('concurrencyView')}
          </button>
          <button type="button" onClick={onMergeOver} className="rounded-md border border-info/40 px-2 py-0.5 font-semibold text-info hover:bg-info/10">
            {t('concurrencyMerge')}
          </button>
        </span>
      </div>
    </div>
  );
}
