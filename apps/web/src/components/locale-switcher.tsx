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
      <Globe className="h-4 w-4 text-gray-500" />
      {LOCALE_CODES.map((code) => {
        const isActive = locale === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => handleChange(code)}
            aria-pressed={isActive}
            className={`rounded px-2 py-1 text-xs transition ${isActive ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10'}`}
          >
            {t(`locale_${code}`)}
          </button>
        );
      })}
    </div>
  );
}
