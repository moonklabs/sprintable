'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { appSetupLink, nativeReturnApp, RETURN_APP_PARAM } from '@/lib/auth/native-return-app';
import { putOrgRemoteControl, useOrgRemoteControl } from '@/lib/org-remote-control';

/**
 * story 4670 (U2 · AC3 · Yuna §E ⑤ + «켜기 전 상태») — the page the app band's [켜고 페어링] opens. Design: nwachukwu 4670-design.md §2-4,
 * changed by Kadir's lens (10-14): nothing here is automatic — [켜기] is the only thing that turns the org's «원격 제어» on, wherever
 * the page was opened (the app's window, a browser, a link in a chat or doc). The page reads the address for one thing only: `#then=pair`
 * (a closed set of one) — the way back to the app's pairing after the switch is on. The org it turns on is the session's
 * (`useDashboardContext().orgId`) and its name stands beside the button; no org is ever taken from the address.
 * Members (and an owner who is not able to change) get the existing «조직 소유자가 켜면…» line — the server refuses them too.
 */
const THEN_FIELD = 'then';

/** `#then=pair` → 'pair'; any other value, or none → null (never a free string into a link) */
export function thenFromFragment(hash: string): 'pair' | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get(THEN_FIELD) === 'pair' ? 'pair' : null;
}

/** the one way this page hands over to the app (a custom-scheme link — not a state change); a seam so a test can see it */
export const appNav = {
  to(url: string): void { window.location.href = url; },
};

export function DesktopRemoteOn() {
  const t = useTranslations('desktop.remoteOn');
  const tRemote = useTranslations('desktop.remote');
  const { orgId, orgMemberships } = useDashboardContext();
  const app = nativeReturnApp(useSearchParams()?.get(RETURN_APP_PARAM));
  const [state, setState] = useOrgRemoteControl(orgId);
  const [then, setThen] = useState<'pair' | null>(null);
  const [phase, setPhase] = useState<'ask' | 'working' | 'done' | 'failed'>('ask');
  const backRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    // read after mount (the address has no meaning on the server); the fragment stays — it is not secret and a reload keeps the way back
    const read = () => setThen(thenFromFragment(window.location.hash));
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  const pairLink = appSetupLink(app, 'pair');
  const orgName = orgMemberships?.find((o) => o.orgId === orgId)?.orgName ?? '';

  // already on when the page opened (or turned on elsewhere meanwhile) with a way back: hand over to the app — a link, not a state change
  const goneBack = useRef(false);
  useEffect(() => {
    if (then !== 'pair' || goneBack.current) return;
    if (phase === 'ask' && state?.enabled) { goneBack.current = true; appNav.to(pairLink); }
  }, [then, phase, state?.enabled, pairLink]);
  useEffect(() => {
    if (then !== 'pair' || phase !== 'done' || goneBack.current) return;
    const timer = window.setTimeout(() => { goneBack.current = true; appNav.to(pairLink); }, 1000);
    return () => window.clearTimeout(timer);
  }, [then, phase, pairLink]);

  if (!orgId || !state) {
    return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={tRemote('loading')} /></Card>;
  }

  const backButton = then === 'pair'
    ? <Button variant="outline" asChild><a ref={backRef} href={pairLink} data-testid="remote-on-back">{t('backToApp')}</a></Button>
    : null;

  // not the person who can change it (a member · an admin): the existing line, the server refuses them as well
  if (!state.can_change && !state.enabled) {
    const owners = state.owner_names ?? [];
    return (
      <Card className="break-keep flex flex-col gap-3 p-6" data-testid="remote-on-not-owner">
        <p className="text-sm" role="status">
          {tRemote('remoteOffOthers', { hasOwners: owners.length > 0 ? 'yes' : 'no', owners: owners.join(', ') })}
        </p>
        {backButton ? <div className="flex gap-2">{backButton}</div> : null}
      </Card>
    );
  }

  if (state.enabled && phase !== 'done') {
    return (
      <Card className="break-keep flex flex-col gap-3 p-6" data-testid="remote-on-already">
        <p className="text-sm" role="status">{then === 'pair' ? t('already') : t('alreadyHere')}</p>
        {backButton ? <div className="flex gap-2">{backButton}</div> : null}
      </Card>
    );
  }

  if (phase === 'done') {
    return (
      <Card className="break-keep flex flex-col gap-3 p-6" data-testid="remote-on-done">
        <p className="text-sm" role="status">{then === 'pair' ? t('done') : t('doneHere')}</p>
        {backButton ? <div className="flex gap-2">{backButton}</div> : null}
      </Card>
    );
  }

  const turnOn = async () => {
    if (phase === 'working') return;
    setPhase('working');
    const result = await putOrgRemoteControl(orgId); // the session's org — the one named beside the button
    if (!result.ok) { setPhase('failed'); return; }
    if (result.data) setState(result.data);
    setPhase('done');
  };

  return (
    <Card className="break-keep flex flex-col gap-3 p-6" data-testid="remote-on-ask">
      <h1 className="text-lg font-semibold">{t('confirmTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('confirmBody')}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* the org this press turns on, in full (no ellipsis · it wraps) — the session's, never one from the address */}
        <p className="text-sm font-medium" data-testid="remote-on-org">{t('orgLine', { org: orgName })}</p>
        <Button onClick={() => void turnOn()} aria-disabled={phase === 'working' || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" data-testid="remote-on-press">
          {phase === 'working' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {phase === 'working' ? t('turningOn') : tRemote('turnOn')}
        </Button>
        {backButton}
      </div>
      {phase === 'failed' ? (
        <p className="text-xs text-destructive" role="alert" data-testid="remote-on-failed">{tRemote('failed')}</p>
      ) : null}
    </Card>
  );
}
