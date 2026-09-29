'use client';

import { Globe } from 'lucide-react';
import { useCallback } from 'react';
import { useLocale } from 'next-intl';

/** 언어를 바꾼다 — `locale` 쿠키(1년) + 새로고침. 사이드바 전환기와 설정 화면 언어 행(story #4413)이 같은 동작을 쓴다. */
export function applyLocale(locale: string) {
  if (typeof window !== 'undefined') {
    window.document.cookie = `locale=${locale};path=/;max-age=${60 * 60 * 24 * 365}`;
    window.location.reload();
  }
}

export function LocaleSwitcher({ className = '' }: { className?: string }) {
  const locale = useLocale();
  const handleToggle = useCallback(() => {
    const next = locale === 'en' ? 'ko' : 'en';
    applyLocale(next);
  }, [locale]);

  return (
    <button
      type="button"
      onClick={handleToggle}
      title={locale === 'en' ? '한국어로 변경' : 'Switch to English'}
      className={`flex items-center gap-1 rounded-xl px-2 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground ${className}`.trim()}
    >
      <Globe className="h-3.5 w-3.5" />
      <span>{locale.toUpperCase()}</span>
    </button>
  );
}
