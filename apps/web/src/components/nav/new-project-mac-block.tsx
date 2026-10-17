'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DesktopDownloadCard, notAMac } from '@/components/desktop/desktop-download-card';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { desktopApp } from '@/lib/desktop-app';
import { connectedSetupsOf, useOrgRemoteControl } from '@/lib/org-remote-control';
import { NEW_PROJECT_LINK } from '@/components/nav/new-project-entry';

const noSubscribe = () => () => undefined;

/**
 * story 4713 AC3 (UX-1 · Yuna `4713-ac3-web-copy-1017.md` form B): in a BROWSER, the «새 프로젝트» dialog keeps its name form as it is and
 * gets one quiet block above it — the Mac app can start a project from a folder. By the count of the organization's connected setups
 * (the web knows only a number, never the Macs' names): one → «Mac 앱에서 이어서» · several → the same with the count · none → «Mac 앱을
 * 받으면 …» and the download. The link opens the app on THIS computer (the OS opens a custom scheme where the browser runs), so there is
 * no list to choose from — «어느 맥에서» is not offered. Not drawn inside the desktop app (it has its own always-visible «새 프로젝트») or
 * the phone app, and not while the count is unknown or failed (never a promise from an unknown count). A browser that is not a Mac's gets
 * the line «Mac에서 이 계정으로 열면 …» in place of the button — the link would open nothing there — and, with several setups, the count alone
 * (Yuna's note on the review: «이 컴퓨터의 앱에서 열려요» would promise an opening that cannot happen there).
 * The button is outline (the dialog keeps its one primary, [만들기]) and presses nothing on the server; the dialog stays open.
 */
export function NewProjectMacBlock({ orgId }: { orgId: string | null | undefined }) {
  const t = useTranslations('nav');
  const tFirst = useTranslations('onboarding.first');
  // inside the desktop app the bridge is there before this dialog can be opened, so it is read, not subscribed to
  const inApp = useSyncExternalStore(noSubscribe, () => !!desktopApp(), () => null);
  const { inPhoneApp } = usePhoneBridge();
  // the device is read after mount (null on the server and before the first read — no hydration mismatch)
  const elsewhere = useSyncExternalStore(noSubscribe, () => notAMac(navigator.userAgent, inPhoneApp), () => null);
  const [remote] = useOrgRemoteControl(orgId);
  if (inApp !== false || inPhoneApp || elsewhere === null || !remote) return null;
  const n = connectedSetupsOf(remote);
  const none = n === 0;

  return (
    <section className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3" data-testid="new-project-mac-block">
      <h3 className="break-keep text-sm font-medium">{none ? t('switcherMacTitleNone') : t('switcherMacTitle')}</h3>
      <p className="break-keep text-xs text-muted-foreground">
        {none ? tFirst('macLead') : n >= 2 ? (elsewhere ? t('switcherMacCountOnly', { n }) : t('switcherMacBodyMany', { n })) : t('switcherMacBody')}
      </p>
      {elsewhere ? (
        <p className="break-keep text-xs text-muted-foreground" data-testid="new-project-mac-elsewhere">{t('switcherMacElsewhere')}</p>
      ) : none ? (
        <DesktopDownloadCard hideTitle ctaVariant="outline" ctaLabel={t('switcherMacActionNone')} />
      ) : (
        <>
          <div>
            <Button asChild variant="outline" size="sm" className="whitespace-nowrap">
              <a href={NEW_PROJECT_LINK} data-testid="new-project-mac-open">{t('switcherMacAction')}</a>
            </Button>
          </div>
          <p className="break-keep text-xs text-muted-foreground">{t('switcherMacNoOpen')}</p>
        </>
      )}
    </section>
  );
}
