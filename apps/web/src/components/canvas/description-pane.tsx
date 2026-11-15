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
      <p className="mb-1 text-ds-small font-semibold text-ds-ink-2">{t('descriptionPaneHeading')}</p>
      {description ? (
        <p className="text-ds-small leading-relaxed text-ds-ink-3">
          {elementLabel ? <strong className="text-ds-ink">{elementLabel}</strong> : null}
          {elementLabel ? ' · ' : ''}
          {description}
        </p>
      ) : (
        <p className="text-ds-small text-ds-ink-3">{t('descriptionEmptyState')}</p>
      )}
    </div>
  );
}
