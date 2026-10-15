'use client';

// story 4668 (UX-1 · U1′ · design mirko/4668-design.md · copy yuna/ux1-copy-1013.md A-2): the app way's one screen «데스크톱 앱 받기»
// in place of the project · agent · connect steps. One card (the existing DesktopDownloadCard — its [다운로드] is the screen's only
// primary button, AC3), one line after it, «더 보기» folded (the org's remote control · the way back to the fork), and a text line
// out: «지금 받지 않아도 돼요 …» + [오늘로 가기]. The organization has no project yet — the desktop setup makes it (4496).

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DesktopDownloadCard } from '@/components/desktop/desktop-download-card';
import { PhoneAppCard } from '@/components/desktop/phone-app-card';
import { OnboardingRemoteControl } from '@/components/desktop/onboarding-remote-control';

interface DesktopGetStepProps {
  /** the organization the onboarding just made — its owner may turn remote control on under «더 보기» (4656) */
  orgId: string | null;
  onBackToChoice: () => void;
  onFinish: () => void;
}

export function DesktopGetStep({ orgId, onBackToChoice, onFinish }: DesktopGetStepProps) {
  const t = useTranslations('onboarding.download');
  const to = useTranslations('onboarding');
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <div className="space-y-4">
      {/* the h1 above is «데스크톱 앱 받기» — the card's own «데스크톱 앱» line would say it twice (Yuna A-2 · PO Q-d) */}
      <DesktopDownloadCard hideTitle />
      <p className="break-keep text-xs text-muted-foreground" data-testid="onboarding-download-after-note">{t('afterNote')}</p>
      {/* story 4654: a device that is not a Mac gets the phone app's store links under the card (on a Mac nothing is drawn) —
          outside «더 보기»: for a person on a phone it is the only way on */}
      <PhoneAppCard />

      <section className="border-t border-border pt-4">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setMoreOpen((open) => !open)}
          aria-expanded={moreOpen}
          aria-controls="onboarding-download-more-panel"
          className="h-auto w-full justify-between px-0 py-1 text-left hover:bg-transparent"
          data-testid="onboarding-download-more"
        >
          <span className="break-keep text-sm font-medium text-foreground">{t('more')}</span>
          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', moreOpen && 'rotate-90')} aria-hidden />
        </Button>
        {moreOpen ? (
          <div id="onboarding-download-more-panel" className="mt-3 space-y-3" data-testid="onboarding-download-more-panel">
            {/* story 4656: the org's remote control, once, for its owner — drawn only when read and off */}
            <OnboardingRemoteControl orgId={orgId} />
            {/* the web way needs an agent and a key, which the app way does not make — so no «또는 웹에서 계속» block here (PO);
                one link back to the fork instead */}
            <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
              <span className="break-keep">{t('switchToWeb')}</span>
              <Button variant="link" size="sm" className="h-auto px-0 py-0 text-xs" onClick={onBackToChoice} data-testid="onboarding-download-back-to-choice">
                {t('backToChoice')}
              </Button>
            </p>
          </div>
        ) : null}
      </section>

      {/* a text link, not a button — the screen's hierarchy stays with [다운로드] (Yuna A-2 · PO ②). The settings tab
          «데스크톱 앱 받기» (settings/page.tsx · flag-free) is where this screen is reopened. */}
      <p className="break-keep text-xs text-muted-foreground" data-testid="onboarding-download-later">
        {t('laterNote')}{' '}
        <Button variant="link" size="sm" className="h-auto px-0 py-0 text-xs" onClick={onFinish} data-testid="onboarding-download-finish">
          {to('desktopFinishToToday')}
        </Button>
      </p>
    </div>
  );
}
