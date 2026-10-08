'use client';

// story #4630 (Yuna «4630» ① · 4624-remote-device-copy.md): «로그인한 다른 기기» — one button ends every other signed-in
// device of this person (a lost phone · a sign-in left on another computer); this browser stays. Only sign-ins end: API keys,
// a desktop setup's agents and paired phone keys are not touched (backend test). The button is outline, not destructive —
// what it ends comes back with a sign-in.

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth, logoutUser } from '@/lib/db/client';

export type OtherSessionsResult = { sessions_ended: number | null; kept_this: boolean };

type SettingsT = ReturnType<typeof useTranslations<'settings'>>;

/** the result line — the server's count of the other sign-ins it ended, when it gave one (story #4630) */
export function otherSessionsLine(t: SettingsT, r: OtherSessionsResult): string {
  if (!r.kept_this) return t('otherSessionsDoneAll');
  if (r.sessions_ended === null) return t('otherSessionsDoneUnknown');
  if (r.sessions_ended === 0) return t('otherSessionsNone');
  return t('otherSessionsDone', { n: r.sessions_ended });
}

export function OtherSessionsSection() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState<OtherSessionsResult | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const signOutOthers = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetchWithAuth('/api/auth/logout-others', { method: 'POST' });
      const json = await res.json().catch(() => ({})) as { data?: { sessions_ended?: number | null; kept_this?: boolean } };
      if (!res.ok || !json.data) throw new Error(String(res.status));
      const n = json.data.sessions_ended;
      setDone({ sessions_ended: typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null, kept_this: json.data.kept_this === true });
      setAsking(false);
      buttonRef.current?.focus();
    } catch {
      setFailed(true); // said inside the dialog, which stays open for another try
    } finally {
      setBusy(false);
    }
  };

  const line = done ? otherSessionsLine(t, done) : null;

  return (
    <SectionCard data-testid="other-sessions">
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground"><LogOut className="size-4" />{t('otherSessionsTitle')}</h2>
          <p className="break-keep text-sm text-muted-foreground">{t('otherSessionsDescription')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-3">
        <p aria-live="polite" className="break-keep text-sm text-foreground" data-testid="other-sessions-done">
          {line}
        </p>
        {done && !done.kept_this ? (
          // Yuna «4630» ①: this browser's sign-in ended too (≤ 1 h until it notices) — one action only: sign out here now and
          // sign in again, rather than be thrown out mid-work later
          <Button ref={buttonRef} variant="outline" onClick={() => { void logoutUser().finally(() => { window.location.href = '/login'; }); }} data-testid="other-sessions-sign-in-again">
            {t('otherSessionsSignInAgain')}
          </Button>
        ) : (
          <Button ref={buttonRef} variant="outline" onClick={() => { setFailed(false); setAsking(true); }} data-testid="other-sessions-open">
            {t('otherSessionsButton')}
          </Button>
        )}
      </SectionCardBody>
      <Dialog open={asking} onOpenChange={(open) => { if (!open && !busy) setAsking(false); }}>
        <DialogContent showCloseButton={false} initialFocus={cancelRef}>
          <DialogHeader>
            <DialogTitle>{t('otherSessionsTitle')}</DialogTitle>
            <DialogDescription className="break-keep">{t('otherSessionsConfirm')}</DialogDescription>
          </DialogHeader>
          {failed ? <p role="alert" className="text-sm text-destructive" data-testid="other-sessions-failed">{t('otherSessionsFailed')}</p> : null}
          <DialogFooter>
            <Button ref={cancelRef} variant="outline" disabled={busy} onClick={() => setAsking(false)}>{tc('cancel')}</Button>
            <Button disabled={busy} onClick={() => void signOutOthers()} data-testid="other-sessions-confirm">
              {busy ? t('otherSessionsWorking') : t('otherSessionsConfirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
