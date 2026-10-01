'use client';

// story #4453 — the teacher signed up in the desktop app, chose a recipe, typed names, pressed «시작», and only then heard
// «verify your e-mail first» (403 EMAIL_VERIFICATION_REQUIRED · dev 04:13 → 04:16Z). The two screens that create an
// organization (desktop setup's new-org mode · /onboarding) now open with this gate instead: the e-mail it went to, [다시
// 보내기], and [다른 주소로 가입하기]. It opens in place — no navigation, so the desktop setup's `#code=…` stays — as soon as
// the server says the e-mail is verified, wherever the link was clicked (another browser · a phone): it reads /api/auth/me
// every 3 s while this tab is visible, and again on focus or when the tab becomes visible.
// No gate when the server does not ask for verification (`email_verification_required` false · a self-hosted server) or the
// person is verified already (a social sign-in). The server's 403 stays as it is — this only puts the step first.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fetchWithAuth, logoutUser } from '@/lib/db/client';
import { pickEuroJosa } from '@/lib/korean-particle';

export const VERIFY_POLL_MS = 3000;

type Me = { email: string | null; verified: boolean | null; required: boolean | null };
type Gate = { kind: 'reading' } | { kind: 'open' } | { kind: 'closed'; email: string | null };
type Resend = 'idle' | 'sending' | 'sent' | 'limited' | 'failed';

/** Whether the gate stays closed for this answer of /api/auth/me: only an explicit «required» and an explicit «not verified». */
export function gateClosed(me: Pick<Me, 'verified' | 'required'>): boolean {
  return me.required === true && me.verified === false;
}

async function readMe(): Promise<Me | null> {
  try {
    const res = await fetchWithAuth('/api/auth/me', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { email?: string | null; email_verified?: boolean | null; email_verification_required?: boolean | null } };
    const d = json.data ?? {};
    return { email: d.email ?? null, verified: d.email_verified ?? null, required: d.email_verification_required ?? null };
  } catch {
    return null;
  }
}

/** Where [다른 주소로 가입하기] sends a person: /register, coming back to this page — without the `#` (the desktop shell puts
 *  the setup values back itself when /desktop/setup opens without them; a `#` would ride along to /register). */
export function registerAgainHref(location: Pick<Location, 'pathname' | 'search'>): string {
  return `/register?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
}

export type VerifyGate = Gate & { resend: Resend; sendAgain: () => void; registerAgain: () => void };

/** The gate's state for a screen that may need it (`active` false → always open: e.g. desktop setup outside new-org mode). */
export function useEmailVerifyGate(active = true): VerifyGate {
  const [gate, setGate] = useState<Gate>({ kind: 'reading' });
  const [resend, setResend] = useState<Resend>('idle');

  // an unreadable answer never holds a person back: the server's own 403 is still there behind the gate
  const apply = useCallback((me: Me | null) => {
    if (!me) { setGate((g) => (g.kind === 'reading' ? { kind: 'open' } : g)); return; }
    setGate((g) => (g.kind === 'open' ? g : gateClosed(me) ? { kind: 'closed', email: me.email } : { kind: 'open' }));
  }, []);
  const check = useCallback(() => { void readMe().then(apply); }, [apply]);

  useEffect(() => {
    if (!active) return;
    let off = false;
    void readMe().then((me) => { if (!off) apply(me); });
    return () => { off = true; };
  }, [active, apply]);

  useEffect(() => {
    if (!active || gate.kind !== 'closed') return;
    // every 3 s while the tab is visible (PO 04:37Z: a hidden tab does not poll); right away on focus or on becoming visible
    const tick = setInterval(() => { if (document.visibilityState === 'visible') check(); }, VERIFY_POLL_MS);
    const now = () => { if (document.visibilityState === 'visible') check(); };
    window.addEventListener('focus', now);
    document.addEventListener('visibilitychange', now);
    return () => { clearInterval(tick); window.removeEventListener('focus', now); document.removeEventListener('visibilitychange', now); };
  }, [active, gate.kind, check]);

  // the answer (auth.py resend_verification): 200 `delivered: true` sent · `delivered: false` not sent (mail not configured
  // or the provider refused) · no `delivered` = already verified → the same as the poll seeing it (Yuna: no words, it opens)
  // · 429 = three an hour (the isolated limiter)
  const sendAgain = useCallback(() => {
    setResend('sending');
    void fetchWithAuth('/api/auth/resend-verification', { method: 'POST' })
      .then(async (res) => {
        if (res.status === 429) { setResend('limited'); return; }
        if (!res.ok) { setResend('failed'); return; }
        const json = (await res.json().catch(() => null)) as { data?: { delivered?: boolean } } | null;
        const delivered = json?.data?.delivered;
        if (delivered === true) setResend('sent');
        else if (delivered === false) setResend('failed');
        else { setResend('idle'); check(); }
      })
      .catch(() => setResend('failed'));
  }, [check]);

  const registerAgain = useCallback(() => {
    void logoutUser().catch(() => undefined).finally(() => window.location.assign(registerAgainHref(window.location)));
  }, []);

  return { ...(active ? gate : { kind: 'open' as const }), resend, sendAgain, registerAgain } as VerifyGate;
}

/** The address in bold inside the sentence the locale built around it (the address only: `break-all` for a long one at 360). */
function BoldPart({ text, part }: { text: string; part: string }) {
  const at = text.indexOf(part);
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<strong className="break-all font-semibold">{part}</strong>{text.slice(at + part.length)}</>;
}

/** The closed gate (Yuna 2faecdde): where the mail went · that the link may be opened anywhere · that this page is waiting ·
 *  [인증 메일 다시 보내기] and its one-line answer · below a thin line, the way out: «주소가 틀렸다면 다른 주소로 가입하기». */
export function EmailVerifyGateCard({ gate }: { gate: Extract<VerifyGate, { kind: 'closed' }> }) {
  const t = useTranslations('emailVerifyGate');
  const answer = gate.resend === 'sent' ? t('resendSent') : gate.resend === 'limited' ? t('resendLimited') : gate.resend === 'failed' ? t('resendFailed') : null;
  return (
    <Card className="break-keep flex flex-col p-6" data-testid="email-verify-gate">
      <p className="text-xs text-muted-foreground">{t('eyebrow')}</p>
      <h1 className="mt-0.5 text-base font-semibold">{t('title')}</h1>
      <p className="mt-2 text-sm">
        {gate.email ? <BoldPart text={t('body', { email: gate.email, euro: pickEuroJosa(gate.email) })} part={gate.email} /> : t('bodyNoEmail')}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{t('anywhere')}</p>
      <p role="status" className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('waiting')}
      </p>
      <div className="mt-4">
        <Button variant="outline" size="sm" onClick={gate.sendAgain} disabled={gate.resend === 'sending'}>{t('resend')}</Button>
        {answer ? <p role="status" className="mt-2 text-xs text-muted-foreground" data-testid="email-verify-gate-resend">{answer}</p> : null}
      </div>
      <p className="-mx-6 mt-5 border-t px-6 pt-3.5 text-xs text-muted-foreground">
        {t('wrongAddress')}{' '}
        <Button variant="link" size="sm" className="h-auto p-0 text-xs underline" onClick={gate.registerAgain}>{t('otherAddress')}</Button>
      </p>
    </Card>
  );
}

/** A screen behind the gate (/onboarding): nothing until /me answers, the gate while unverified, then the screen in place. */
export function EmailVerifyGate({ children }: { children: ReactNode }) {
  const gate = useEmailVerifyGate();
  if (gate.kind === 'reading') return null; // no gate flashing past a verified person
  // on its own page (/onboarding): centered like the onboarding forms it stands in for — 16px sides at 360
  if (gate.kind === 'closed') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md"><EmailVerifyGateCard gate={gate} /></div>
      </div>
    );
  }
  return <>{children}</>;
}
