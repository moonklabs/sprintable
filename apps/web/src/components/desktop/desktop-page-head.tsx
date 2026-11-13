'use client';

// story 4889 (W7~W10 · AC3 §2 «이 컴퓨터» 화면째): the page's one line saying what the screen holds. The cards below were six separate pieces with no head; now the page reads: note → two columns (the app · the phone) →
// the connected computers across the full width. 4913: the TITLE is the app frame's top bar's (DesktopScreenTitle) — no body <h1> here (the frame rule G1).
import { useTranslations } from 'next-intl';

export function DesktopPageHead() {
  const t = useTranslations('desktop');
  return (
    <header data-testid="desktop-page-head">
      <p className="break-keep text-sm text-muted-foreground">{t('pageNote')}</p>
    </header>
  );
}
