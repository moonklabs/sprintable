'use client';

import { Globe } from 'lucide-react';
import { useCallback } from 'react';
import { useLocale, useTranslations } from 'next-intl';

const LOCALE_CODES = ['en', 'ko'] as const;

function setLocaleCookie(locale: string) {
  if (typeof window !== 'undefined') {
    window.document.cookie = `locale=${locale};path=/;max-age=${60 * 60 * 24 * 365}`;
    window.location.reload();
  }
}

export function LocaleSwitcher({ className = '' }: { className?: string }) {
  const locale = useLocale();
  const t = useTranslations('common');
  const handleChange = useCallback((nextLocale: string) => {
    if (nextLocale === locale) return;
    setLocaleCookie(nextLocale);
  }, [locale]);

  return (
    <div className={`flex items-center gap-1 ${className}`.trim()}>
      <Globe className="h-4 w-4 text-[color:var(--operator-muted)]" />
      {LOCALE_CODES.map((code) => {
        const isActive = locale === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => handleChange(code)}
            aria-pressed={isActive}
            className={`rounded-xl px-2.5 py-1.5 text-xs font-medium transition ${
              isActive
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-[color:var(--operator-muted)] hover:bg-[color:var(--operator-surface-soft)] hover:text-[color:var(--operator-foreground)]'
            }`}
          >
            {t(`locale_${code}`)}
          </button>
        );
      })}
    </div>
  );
}
