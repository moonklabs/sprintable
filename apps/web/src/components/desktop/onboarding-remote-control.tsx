'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { useOrgRemoteControl } from '@/lib/org-remote-control';

/**
 * story #4656 (E-DESKTOP-2 · 1선) — the onboarding's connect step turns the org's «원격 제어» on, once, for its owner.
 * Design: nwachukwu `onboarding-remote-control-design.md` + yuna `4656-design.md` (copy · failure line · no flash while the value
 * is read). Shown only when the value is read, the person can change it (owner), and it is off. [나중에 하기] sends nothing:
 * the org stays off. The switch itself is the existing PUT `/api/organizations/{id}/remote-control` (owner-only on the server).
 */
export function OnboardingRemoteControl({ orgId }: { orgId: string | null }) {
  const t = useTranslations('onboarding.remoteControl');
  const [state, setState] = useOrgRemoteControl(orgId);
  const [later, setLater] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);

  // not read yet (no flash) · not an owner · already on · the person chose later → nothing (done keeps its line)
  if (!orgId) return null;
  if (!done && (!state || !state.can_change || state.enabled || later)) return null;

  const enable = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/remote-control`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
      });
      if (!res.ok) { setFailed(true); return; }
      const next = ((await res.json()) as { data?: typeof state }).data;
      if (next) setState(next);
      setDone(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return <p className="text-sm text-foreground" role="status" data-testid="onboarding-remote-control-done">{t('enabled')}</p>;
  }

  return (
    <div className="space-y-2" data-testid="onboarding-remote-control">
      <p className="text-sm font-semibold text-foreground">{t('title')}</p>
      <p className="text-xs text-muted-foreground">{t('body')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void enable()} disabled={busy}>{t('enable')}</Button>
        <Button size="sm" variant="ghost" onClick={() => setLater(true)} disabled={busy}>{t('later')}</Button>
      </div>
      {failed ? <p className="text-xs text-destructive" role="alert" data-testid="onboarding-remote-control-failed">{t('failed')}</p> : null}
    </div>
  );
}
