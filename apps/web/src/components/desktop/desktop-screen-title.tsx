'use client';

// 4913 — the «이 컴퓨터와 폰» screen's title lives on the app frame's top bar (OrgScreenTitle → TopBarSlot), not in the body (the frame rule G1). The name is the sidebar's: «데스크톱 앱» (desktop.pageTitle = nav.desktopApp —
// pinned by verify-nav-label-matches-title). A client wrapper because the page is a server component that returns its tree synchronously.
import { useTranslations } from 'next-intl';
import { OrgScreenTitle } from '@/components/organization/org-screen-title';

export function DesktopScreenTitle() {
  const t = useTranslations('desktop');
  return <OrgScreenTitle>{t('pageTitle')}</OrgScreenTitle>;
}
