'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';

// story 4712 — the confirm card of «브라우저 이어받기». [열기] is the only thing that makes a code (a person's press — no auto-submit); the answer is
// the return page's address, which a person taps there (the existing page). [다른 계정으로] signs this browser out and comes back to this same page.
interface Props {
  account: string;
  start: { challenge: string; returnApp: 'check' | 'dev' | null };
  /** this page's own address with the app's start parameters — where a sign-in (or a switch of account) comes back to */
  here: string;
}

export function DesktopContinueCard({ account, start, here }: Props) {
  const t = useTranslations('desktopContinue');
  const [state, setState] = useState<'idle' | 'opening' | 'error'>('idle');

  async function open() {
    if (state === 'opening') return;
    setState('opening');
    try {
      const res = await fetchWithAuth('/api/desktop/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code_challenge: start.challenge, cc_method: 'S256', callback_mode: 'custom_scheme',
          ...(start.returnApp ? { return_app: start.returnApp } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as { data?: { url?: unknown } } | null;
      const url = body?.data?.url;
      if (!res.ok || typeof url !== 'string' || !url.startsWith('/native/oauth-return?')) { setState('error'); return; }
      window.location.assign(url);
    } catch {
      setState('error');
    }
  }

  async function otherAccount() {
    try { await fetchWithAuth('/api/auth/logout', { method: 'POST' }); } catch { /* the sign-in page shows whatever is still there */ }
    window.location.assign(`/login?next=${encodeURIComponent(here)}`);
  }

  return (
    <div className="w-full max-w-sm rounded-2xl bg-background p-8 text-center shadow-sm">
      <h1 className="mb-2 text-lg font-semibold text-foreground">{t('title')}</h1>
      <p className="mb-1 break-keep text-sm text-foreground" data-testid="continue-account">{t('account', { account })}</p>
      <p className="mb-6 break-keep text-sm text-muted-foreground">{t('body')}</p>
      <Button type="button" onClick={open} disabled={state === 'opening'} className="w-full">
        {state === 'opening' ? t('opening') : t('open')}
      </Button>
      {state === 'error' && <p role="alert" className="mt-3 text-sm text-destructive">{t('error')}</p>}
      <Button type="button" variant="link" size="sm" onClick={otherAccount} className="mt-4 text-xs text-muted-foreground underline">{t('otherAccount')}</Button>
    </div>
  );
}
