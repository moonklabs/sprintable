'use client';

// story 4715 (UX-1 · plan yuna/4715-plan-1016.md §2) · story 5036 (C6): the onboarding's step ② — «에이전트 연결» — after the project step ①.
// A browser (a Mac or not) gets the three ways side by side (connect-branches.tsx — no fold, the same weight). The places that are not a browser keep
// their own screen as they were: the phone app (its pairing screen — a phone pairs with a Mac and starts its agents from it), a workspace SERVER HOST (the
// one command for the computer that will run the agent) and the Mac app itself (it goes to its own setup page, which makes the project itself) — none of those
// comes through the project step. Phone control is not offered here — it is asked when a phone is paired (PO).

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { notAMac } from '@/components/desktop/desktop-download-card';
import { ServerHostAgentCard } from '@/components/desktop/server-host-agent-card';
import { Chip } from '@/components/ds/chip';
import { PhoneFirstScreen } from '@/components/desktop/phone-first-screen';
import { desktopApp } from '@/lib/desktop-app';
import { useFlatHref } from '@/hooks/use-flat-href';
import { ConnectBranches } from './connect-branches';
import { markLeaving } from '@/lib/phone-start';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';

const noSubscribe = () => () => undefined;

interface FirstScreenProps {
  /** story 4714: the organization's id — the phone app's screen needs it to turn remote control on (null: not known here) */
  orgId?: string | null;
  /** story 4714: where «대화» is (the server resolved it from the nav flags — never a literal here) */
  chatsHref?: string;
  /** story 4714 AC2: the server's judgement that the Mac app is offered here — the phone screen's mail button is drawn only then */
  macDownloadEnabled?: boolean;
  /** story 5024 (AC4): the server's own public address when this is a workspace SERVER HOST's onboarding — the screen then tells how to attach an agent to THIS server (no Mac app is offered there). null = not a server host. */
  serverHostOrigin?: string | null;
  /** story 5024 (F1): a SERVER HOST whose public address is not set yet — the same screen, its card saying «set the public address first» (the address cannot be set before an owner exists, so this is where the first owner lands). */
  serverHostPending?: boolean;
  /** the organization's name when this page made it (or read it) — null: not known here, the line is not drawn (never made up) */
  orgName: string | null;
  /** story 5036: the project step ① made — the browser's key way puts its agent on it (null: a place that has no project step — the phone app · a server host · the Mac app) */
  projectId?: string | null;
  /** story 5036: the Mac app person is on the first-run line (a NEW account — the form decided it) — this screen is then the three ways, not the redirect to the app's own start screen */
  appLine?: boolean;
  /** story 5036: the key way's agent connected (its first call was seen) — the page moves on to step ③ */
  onConnected?: (agentId: string) => void;
  /** story 4766: the landing the page's way out ends on (the person's «오늘»/«대시보드» word follows this) */
  todayV3Enabled?: boolean;
  /** story 4780: the Today address the server resolved from the nav flags (never a literal here) — the phone's pairing screen [Close] goes there: this screen is not worth coming back to once the phone is paired, Today's checklist goes on */
  todayHref?: string;
  /** «지금 받지 않아도 돼요 …» [오늘로 가기] */
  onFinish: () => void;
}

export function FirstScreen({ orgId = null, chatsHref, macDownloadEnabled = false, serverHostOrigin = null, serverHostPending = false, orgName, projectId = null, appLine = false, onConnected, todayV3Enabled = false, todayHref, onFinish }: FirstScreenProps) {
  const t = useTranslations('onboarding.first');
  const tLine = useTranslations('onboarding.line');
  const to = useTranslations('onboarding');
  // the device is read after mount (null on the server and before the first read — no hydration mismatch), as the card does
  const { inPhoneApp } = usePhoneBridge();
  const [advancedBusy, setAdvancedBusy] = useState(false); // story 4766: while the web way's press is making the agent and its key, the other way out waits
  const finish = () => { if (advancedBusy) return; if (markLeaving()) onFinish(); }; // stops the flows that are out; a second tap is not a second finish // a way out: a start still being waited for in the phone's screen must not move the page after it
  const elsewhere = useSyncExternalStore(noSubscribe, () => notAMac(navigator.userAgent, inPhoneApp), () => null);
  // story 4763 AC14 (the «앱 먼저» customer path: login screen «Mac 앱 받기» → the app → sign-up): inside the Mac app the download card is for someone who has no app yet — here the next step
  // is the app's own setup page. In a browser `desktopApp()` is undefined and every screen below stays as it is (read after mount: null on the server and before the first read).
  const inMacApp = useSyncExternalStore(noSubscribe, () => !!desktopApp(), () => null);
  // once: React's StrictMode replays effects in development — the page must not navigate twice. The code-less `/desktop/setup` is the app's own entrance: the app notices that page loading
  // (`did-navigate` → the setup flow's «setup page arrival», sprintable-mobile desktop-electron/src/setup-wiring.ts · setup-flow.ts) and hands it its values, as it does when it opens the page itself.
  const wentToSetup = useRef(false);
  const flatHref = useFlatHref(); // story 4763 AC14: the app's own setup page (folder · agent · [시작]) is a flat destination — it carries the project like every other entrance (the ratchet: no bare flat destination)
  // (story 5036: a Mac app person on the first-run line — a new account that made the project in step ① — stays here: the three ways are this screen, and the first of them opens the start screen itself.
  //  Anyone else in the app goes to the start screen as it always did, whatever else the page holds)
  const goesToSetup = inMacApp === true && !appLine;
  useEffect(() => { if (goesToSetup && !wentToSetup.current) { wentToSetup.current = true; window.location.replace(flatHref('/desktop/setup')); } }, [goesToSetup]);
  // story 5024 (AC4): a workspace SERVER HOST has no Mac app to get — «에이전트는 내 Mac에서 돌아가요 · 지금은 받을 수 없어요» told the person who set the server up nothing about how an agent gets attached. Here: the one command for the
  // computer that will run the agent, with this server's own address filled in. (Any browser — the server host's people are not on a Mac by assumption: no Mac-or-not fork.)
  if (serverHostOrigin !== null || serverHostPending) {
    const hostFinishLabel = todayV3Enabled ? to('desktopFinishToToday') : to('dashboardCta');
    return (
      <div className="space-y-4" data-testid="onboarding-first-server-host">
        <div className="text-center">
          <h1 id="onboarding-step-title" className="break-keep text-2xl font-bold text-foreground">{t('serverHostTitle')}</h1>
          <p className="mt-2 break-keep text-sm text-muted-foreground">{t('serverHostLead')}</p>
        </div>
        <ServerHostAgentCard origin={serverHostOrigin} hideTitle testId="onboarding-first-server-host-card" />
        {orgName ? <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" data-testid="onboarding-first-org">{t('orgLead')} <Chip className="min-w-0 max-w-full truncate">{orgName}</Chip></p> : null}
        <p className="flex flex-wrap items-center gap-x-1.5 break-keep border-t border-border pt-2 text-xs text-muted-foreground" data-testid="onboarding-first-later">
          {t('laterShort')}
          <Button variant="quiet" className="px-2 text-xs" onClick={finish} disabled={advancedBusy} data-testid="onboarding-first-finish">{hostFinishLabel}</Button>
        </p>
      </div>
    );
  }
  if (elsewhere === null || inMacApp === null) return null;
  if (goesToSetup) return null; // the page is going to the setup page
  // story 4891: the way out's word follows where it lands (resolveOnboardingLandingHref: flag ON → Today, OFF → «대화»), as the three other onboarding exits already do
  // (advanced-connect · connect-step · phone-start-page). It said «Go to Today» always, and on a build with the flag off it landed on the chats page.
  const finishLabel = todayV3Enabled ? to('desktopFinishToToday') : to('dashboardCta');

  // story 4714 (AC1 · Yuna 4714-copy-1017): inside the phone app the Mac-or-not fork is not drawn — the phone's own screen takes its place
  // (a phone pairs with a Mac and starts its agents from it; «지금은 Mac 앱만 있어요» would say the opposite). Other non-Mac browsers keep theirs.
  if (inPhoneApp) {
    return (
      <div className="space-y-4" data-testid="onboarding-first-phone-app">
        <PhoneFirstScreen orgId={orgId} chatsHref={chatsHref} macDownloadEnabled={macDownloadEnabled} returnHref={todayHref} />
        <p className="flex flex-wrap items-center gap-x-1.5 break-keep border-t border-border pt-2 text-xs text-muted-foreground" data-testid="onboarding-first-later">
          {to('download.laterNote')}
          <Button variant="quiet" className="px-2 text-xs" onClick={finish} disabled={advancedBusy} data-testid="onboarding-first-finish">
            {finishLabel}
          </Button>
        </p>
      </div>
    );
  }

  // story 4891 (PO 11-10): which organization the app attaches to stays on the screen (it stops a wrong attach) — but as «시작 조직 [이름]», one chip, not a sentence
  const orgLine = orgName
    ? <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" data-testid="onboarding-first-org">{t('orgLead')} <Chip className="min-w-0 max-w-full truncate">{orgName}</Chip></p>
    : null;

  return (
    <div className="space-y-4" data-testid={elsewhere ? 'onboarding-first-not-mac' : 'onboarding-first-mac'}>
      <div className="space-y-2 text-center">
        <h1 id="onboarding-step-title" className="break-keep text-ds-title font-semibold text-ds-ink">{tLine('connectTitle')}</h1>
        <p className="break-keep text-ds-body text-ds-ink-2">{tLine('connectLead')}</p>
      </div>

      {/* story 5036: the three ways side by side, the same weight (no «고급» fold). `projectId` is the project step ①'s — a browser always has it by here */}
      {projectId ? (
        <ConnectBranches orgId={orgId} projectId={projectId} isMac={!elsewhere} inApp={inMacApp === true} onConnected={(agentId) => onConnected?.(agentId)} onWorking={setAdvancedBusy} />
      ) : null}
      {orgLine}

      {/* a text line out, not a button in the hierarchy (Yuna A-2 · PO ②) */}
      <p className="flex flex-wrap items-center gap-x-1.5 break-keep border-t border-border pt-2 text-xs text-muted-foreground" data-testid="onboarding-first-later">
        {t('laterShort')}
        <Button variant="quiet" className="px-2 text-xs" onClick={finish} disabled={advancedBusy} data-testid="onboarding-first-finish">
          {finishLabel}
        </Button>
      </p>
    </div>
  );
}
