'use client';

import { Globe } from 'lucide-react';
import { useCallback } from 'react';
import { useLocale } from 'next-intl';

const LOCALE_CODES = ['en', 'ko'] as const;

function setLocaleCookie(locale: string) {
  if (typeof window !== 'undefined') {
    window.document.cookie = `locale=${locale};path=/;max-age=${60 * 60 * 24 * 365}`;
    window.location.reload();
  }
}

export function LocaleSwitcher({ className = '' }: { className?: string }) {
  const locale = useLocale();
  const handleToggle = useCallback(() => {
    const next = locale === 'en' ? 'ko' : 'en';
    setLocaleCookie(next);
  }, [locale]);

  return (
    <button
      type="button"
      onClick={handleToggle}
      title={locale === 'en' ? '한국어로 변경' : 'Switch to English'}
      className={`flex items-center gap-1 rounded-xl px-2 py-1.5 text-xs font-medium text-[color:var(--operator-muted)] transition hover:bg-[color:var(--operator-surface-soft)] hover:text-[color:var(--operator-foreground)] ${className}`.trim()}
    >
      <Globe className="h-3.5 w-3.5" />
      <span>{locale.toUpperCase()}</span>
    </button>
  );
}
