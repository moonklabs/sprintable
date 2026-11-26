'use client';

// story 5036 (C6 · step ② of the onboarding's straight line): the three ways to connect an agent, side by side on ONE screen, the same weight —
// no «고급» fold. ① make one new (a role → the default guidance → run in the app's own terminal) · ② move one already in use · ③ hand a key to one
// that is already running (MCP · plugin), which is the only way that goes all the way in the browser.
// A browser cannot do ① and ②: they say «데스크톱 앱에서 해요», open the app on THAT way (the app's own links: `appSetupLink` — new · `move`) and
// the page offers the download once, under the three (never a dead end that only says «open it in the app»). A computer that is not a Mac says
// why in words under those two (a reason in plain text, not only a button gone) and keeps the key way.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import { DesktopDownloadCard } from '@/components/desktop/desktop-download-card';
import { PhoneAppCard, PhoneAppRow } from '@/components/desktop/phone-app-card';
import { appSetupLink } from '@/lib/auth/native-return-app';
import { AdvancedConnect } from './advanced-connect';
import { emitOnboardingEvent } from './onboarding-telemetry';

/** the three ways, in the order they are drawn — the structure test pins this list and the order (a revert turns it red) */
export const CONNECT_BRANCH_IDS = ['new', 'move', 'key'] as const;
export type ConnectBranchId = (typeof CONNECT_BRANCH_IDS)[number];

interface ConnectBranchesProps {
  orgId: string | null;
  /** the project step ① made — the key way puts its agent on it */
  projectId: string;
  /** false: a computer that is not a Mac — the two app ways say why they are not offered */
  isMac: boolean;
  /** the key way's agent connected (its first call was seen) */
  onConnected: (agentId: string) => void;
  /** the key way is making things: the page's other way out waits */
  onWorking: (working: boolean) => void;
}

export function ConnectBranches({ orgId, projectId, isMac, onConnected, onWorking }: ConnectBranchesProps) {
  const t = useTranslations('onboarding.line');
  const tFirst = useTranslations('onboarding.first');
  const tDownload = useTranslations('onboarding.download');
  const [downloaded, setDownloaded] = useState(false); // the download was pressed — «after the download» is said from here (not before: the screen before the press is read for «what do I press»)

  /** a way that only the app does: its words · the app-open link on THAT way · or, off a Mac, why it is not offered */
  const appWay = (id: 'new' | 'move') => (
    <Card key={id} className="space-y-3 p-4" data-testid={`connect-branch-${id}`}>
      <div className="flex items-start justify-between gap-2">
        <h2 className="break-keep text-ds-card-title font-semibold text-ds-ink">{t(id === 'new' ? 'branchNewTitle' : 'branchMoveTitle')}</h2>
        <Chip>{t('inApp')}</Chip>
      </div>
      <p className="break-keep text-ds-body text-ds-ink-2">{t(id === 'new' ? 'branchNewBody' : 'branchMoveBody')}</p>
      {isMac ? (
        <Button asChild variant="secondary" size="lg" className="w-full">
          <a href={id === 'new' ? appSetupLink(null) : appSetupLink(null, 'move')} data-testid={`connect-branch-${id}-open`}>
            {t(id === 'new' ? 'openAppNew' : 'openAppMove')}
          </a>
        </Button>
      ) : (
        <p className="break-keep text-ds-small text-ds-ink-3" data-testid={`connect-branch-${id}-reason`}>{t('notMacReason')}</p>
      )}
    </Card>
  );

  return (
    <section aria-label={t('branchesLabel')} className="space-y-3" data-testid="connect-branches">
      {appWay('new')}
      {appWay('move')}

      <Card className="space-y-3 p-4" data-testid="connect-branch-key">
        <h2 className="break-keep text-ds-card-title font-semibold text-ds-ink">{t('branchKeyTitle')}</h2>
        <p className="break-keep text-ds-body text-ds-ink-2">{t('branchKeyBody')}</p>
        <AdvancedConnect orgId={orgId} projectId={projectId} onConnected={onConnected} onWorking={onWorking} />
      </Card>

      {isMac ? (
        <div className="space-y-2" data-testid="connect-branches-download">
          <p className="break-keep text-ds-small text-ds-ink-3">{t('noAppYet')}</p>
          {/* the 3983 funnel's «went the desktop way» signal — sent on the download press, as the first screen always did */}
          <DesktopDownloadCard hideTitle ctaLabel={tFirst('macCta')} onCta={() => { setDownloaded(true); emitOnboardingEvent('desktop_handoff_selected', { agent_id: null, flow: 'onboarding' }); }} />
          {downloaded ? <p className="break-keep text-ds-small text-ds-ink-3" data-testid="connect-branches-after-note">{tDownload('afterNote')}</p> : null}
          {/* story 4671 (U3): a Mac draws the phone app's QR too — the person at the Mac is who needs it */}
          <PhoneAppRow />
        </div>
      ) : (
        /* story 4654: a phone gets the phone app's store links */
        <PhoneAppCard />
      )}
    </section>
  );
}
