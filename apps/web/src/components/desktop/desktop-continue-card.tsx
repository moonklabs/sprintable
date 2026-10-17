'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';

// story 4712 — the confirm card of «브라우저 이어받기». [열기] is the only thing that makes a code (a person's press — no auto-submit); the answer is
// the return page's address, which a person taps there (the existing page). [다른 계정으로] signs this browser out and comes back to this same page.
// AC4 (c) (PO 10-17): [열기] is a plain FORM POST to /native/continue/open — it works the instant the page is on screen, before any script has run (the
// walk of c1372ee9c: a click handler that is not attached yet made the press do nothing for ~2 s). The page's script only adds the «여는 중…» look.
interface Props {
  account: string;
  start: { challenge: string; returnApp: 'check' | 'dev' | null };
  /** this page's own address with the app's start parameters — where a sign-in (or a switch of account) comes back to */
  here: string;
  /** the form route came back with a failure (the code could not be made): say so, the button is there again */
  failed?: boolean;
}

export function DesktopContinueCard({ account, start, here, failed = false }: Props) {
  const t = useTranslations('desktopContinue');
  const [opening, setOpening] = useState(false);
  // a page restored from the back/forward cache must not stay on «여는 중…»
  useEffect(() => {
    const back = (e: PageTransitionEvent) => { if (e.persisted) setOpening(false); };
    window.addEventListener('pageshow', back);
    return () => window.removeEventListener('pageshow', back);
  }, []);

  async function otherAccount() {
    try { await fetchWithAuth('/api/auth/logout', { method: 'POST' }); } catch { /* the sign-in page shows whatever is still there */ }
    window.location.assign(`/login?next=${encodeURIComponent(here)}`);
  }

  return (
    <div className="w-full max-w-sm rounded-2xl bg-background p-8 text-center shadow-sm">
      <h1 className="mb-2 text-lg font-semibold text-foreground">{t('title')}</h1>
      <p className="mb-1 break-keep text-sm text-foreground" data-testid="continue-account">{t('account', { account })}</p>
      <p className="mb-6 break-keep text-sm text-muted-foreground">{t('body')}</p>
      <form method="post" action="/native/continue/open" onSubmit={(e) => { if (opening) { e.preventDefault(); return; } setOpening(true); }} data-testid="continue-form">
        <input type="hidden" name="code_challenge" value={start.challenge} />
        <input type="hidden" name="cc_method" value="S256" />
        <input type="hidden" name="callback_mode" value="custom_scheme" />
        {start.returnApp ? <input type="hidden" name="return_app" value={start.returnApp} /> : null}
        <Button type="submit" className="w-full" disabled={opening}>
          {opening ? t('opening') : t('open')}
        </Button>
      </form>
      {failed && <p role="alert" className="mt-3 text-sm text-destructive">{t('error')}</p>}
      <Button type="button" variant="link" size="sm" onClick={otherAccount} className="mt-4 text-xs text-muted-foreground underline">{t('otherAccount')}</Button>
    </div>
  );
}
