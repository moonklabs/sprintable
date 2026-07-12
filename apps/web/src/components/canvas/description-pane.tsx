import { useTranslations } from 'next-intl';

interface DescriptionPaneProps {
  description: string | null;
  elementLabel?: string | null;
  className?: string;
}

/**
 * E-CANVAS C2 §4 — 요소별 "보이는 PRD"(spec_description 유산). 읽기 전용(편집=C3 스코프).
 * 선택된 요소가 없거나 스펙이 없으면 중립 안내(낙인/촉구 문구 금지 — E-VERIFY §6 원칙 계승).
 */
export function DescriptionPane({ description, elementLabel, className }: DescriptionPaneProps) {
  const t = useTranslations('canvas');
  return (
    <div className={className}>
      <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{t('descriptionPaneHeading')}</p>
      {description ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {elementLabel ? <strong className="text-foreground">{elementLabel}</strong> : null}
          {elementLabel ? ' · ' : ''}
          {description}
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground/70">{t('descriptionEmptyState')}</p>
      )}
    </div>
  );
}
