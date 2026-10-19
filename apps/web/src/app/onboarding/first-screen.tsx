'use client';

// story 4715 (UX-1 · plan yuna/4715-plan-1016.md §2): the onboarding's one screen after the organization — in place of the fork
// («에이전트를 어디서 돌릴까요?») and the «데스크톱 앱 받기» screen. On a Mac: the app is the way, [Mac 앱 받기] is the one primary, and a
// small link leads to the web way (an agent already running somewhere else — the key and settings screens live only there). Not a Mac:
// «지금은 Mac 앱만 있어요» first, the web way as the one button, no download card (it cannot install there). Phone control is not offered
// here — it is asked when a phone is paired (PO).

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DesktopDownloadCard, notAMac } from '@/components/desktop/desktop-download-card';
import { PhoneAppCard } from '@/components/desktop/phone-app-card';
import { PhoneFirstScreen } from '@/components/desktop/phone-first-screen';
import { markLeaving } from '@/lib/phone-start';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { emitOnboardingEvent } from './onboarding-telemetry';

const noSubscribe = () => () => undefined;

interface FirstScreenProps {
  /** story 4714: the organization's id — the phone app's screen needs it to turn remote control on (null: not known here) */
  orgId?: string | null;
  /** story 4714: where «대화» is (the server resolved it from the nav flags — never a literal here) */
  chatsHref?: string;
  /** story 4714 AC2: the server's judgement that the Mac app is offered here — the phone screen's mail button is drawn only then */
  macDownloadEnabled?: boolean;
  /** the organization's name when this page made it (or read it) — null: not known here, the line is not drawn (never made up) */
  orgName: string | null;
  /** the web way: project → agent → connect */
  onConnectElsewhere: () => void;
  /** «지금 받지 않아도 돼요 …» [오늘로 가기] */
  onFinish: () => void;
}

export function FirstScreen({ orgId = null, chatsHref, macDownloadEnabled = false, orgName, onConnectElsewhere, onFinish }: FirstScreenProps) {
  const t = useTranslations('onboarding.first');
  const to = useTranslations('onboarding');
  // the device is read after mount (null on the server and before the first read — no hydration mismatch), as the card does
  const { inPhoneApp } = usePhoneBridge();
  const finish = () => { if (markLeaving()) onFinish(); }; // stops the flows that are out; a second tap is not a second finish // a way out: a start still being waited for in the phone's screen must not move the page after it
  const elsewhere = useSyncExternalStore(noSubscribe, () => notAMac(navigator.userAgent, inPhoneApp), () => null);
  if (elsewhere === null) return null;

  // story 4714 (AC1 · Yuna 4714-copy-1017): inside the phone app the Mac-or-not fork is not drawn — the phone's own screen takes its place
  // (a phone pairs with a Mac and starts its agents from it; «지금은 Mac 앱만 있어요» would say the opposite). Other non-Mac browsers keep theirs.
  if (inPhoneApp) {
    return (
      <div className="space-y-4" data-testid="onboarding-first-phone-app">
        <PhoneFirstScreen orgId={orgId} chatsHref={chatsHref} macDownloadEnabled={macDownloadEnabled} />
        <p className="break-keep border-t border-border pt-4 text-xs text-muted-foreground" data-testid="onboarding-first-later">
          {to('download.laterNote')}{' '}
          <Button variant="link" size="sm" className="h-auto px-0 py-0 text-xs" onClick={finish} data-testid="onboarding-first-finish">
            {to('desktopFinishToToday')}
          </Button>
        </p>
      </div>
    );
  }

  const connectNote = <p className="break-keep text-xs text-muted-foreground">{t('connectNote')}</p>;
  const orgLine = orgName
    ? <p className="break-keep text-xs text-muted-foreground" data-testid="onboarding-first-org">{t('orgLine', { org: orgName })}</p>
    : null;

  return (
    <div className="space-y-4" data-testid={elsewhere ? 'onboarding-first-not-mac' : 'onboarding-first-mac'}>
      <div className="text-center">
        <h1 id="onboarding-step-title" className="break-keep text-2xl font-bold text-foreground">{elsewhere ? t('notMacTitle') : t('macTitle')}</h1>
        <p className="mt-2 break-keep text-sm text-muted-foreground">{elsewhere ? t('notMacLead') : t('macLead')}</p>
      </div>

      {elsewhere ? (
        <>
          <div className="space-y-1">
            <Button variant="outline" size="lg" className="w-full" onClick={onConnectElsewhere} data-testid="onboarding-first-connect">
              {t('connect')}
            </Button>
            {connectNote}
          </div>
          {/* story 4654: a phone gets the phone app's store links (on a Mac nothing is drawn) */}
          <PhoneAppCard />
          {orgLine}
        </>
      ) : (
        <>
          {/* the h1 already says what this is — the card's own «데스크톱 앱» title is not drawn twice (Yuna A-2) */}
          {/* the 3983 funnel's «went the desktop way» signal — sent where the fork's app choice used to send it, now on the download press */}
          <DesktopDownloadCard hideTitle ctaLabel={t('macCta')} onCta={() => emitOnboardingEvent('desktop_handoff_selected', { agent_id: null, flow: 'onboarding' })} />
          <p className="break-keep text-xs text-muted-foreground" data-testid="onboarding-first-after-note">{to('download.afterNote')}</p>
          {/* story 4671 (U3): a Mac draws the phone app's QR too — the person at the Mac is who needs it; nothing to get → nothing drawn */}
          <PhoneAppCard />
          {orgLine}
          <div className="space-y-1">
            <Button variant="link" size="sm" className="h-auto whitespace-normal px-0 py-0 text-left text-xs" onClick={onConnectElsewhere} data-testid="onboarding-first-connect">
              {t('connect')}
            </Button>
            {connectNote}
          </div>
        </>
      )}

      {/* a text line out, not a button in the hierarchy (Yuna A-2 · PO ②) */}
      <p className="break-keep border-t border-border pt-4 text-xs text-muted-foreground" data-testid="onboarding-first-later">
        {to('download.laterNote')}{' '}
        <Button variant="link" size="sm" className="h-auto px-0 py-0 text-xs" onClick={finish} data-testid="onboarding-first-finish">
          {to('desktopFinishToToday')}
        </Button>
      </p>
    </div>
  );
}
