'use client';

// story 4889 (W7~W10 · AC3 §2 «이 컴퓨터» 화면째): the page's own head — one title and one line saying what the screen holds. The cards below were six separate pieces with no head;
// now the page reads: head → two columns (the app · the phone) → the connected computers across the full width.
import { useTranslations } from 'next-intl';

export function DesktopPageHead() {
  const t = useTranslations('desktop');
  return (
    <header className="space-y-1" data-testid="desktop-page-head">
      <h1 className="m-0 text-lg font-semibold text-foreground">{t('pageTitle')}</h1>
      <p className="break-keep text-sm text-muted-foreground">{t('pageNote')}</p>
    </header>
  );
}
