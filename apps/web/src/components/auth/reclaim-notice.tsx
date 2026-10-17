'use client';

// story 4725 decision 2 (Yuna 4725 notice copy, 2026-10-17): the person whose unproved account was reclaimed (the moment their mailbox was proved —
// a verified provider sign-in, the mail link, a mailed reset) is told ONCE what was cut. The server holds the «show once» mark and says what it really
// cut (`GET /api/auth/me` → `reclaim_notice`: {cut: [...], password_cleared}); this draws it, and [닫기] clears the server's mark so it does not come back.
// Neutral (info) notice · role=status · never closes by itself · one outline button on the right. It is drawn only while the server has the mark, and the
// list names only what the server says it cut (a «cut» for what never existed would be false).
import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { pickEulReulJosa } from '@/lib/korean-particle';

export type ReclaimCut = 'sessions' | 'providers' | 'two_step' | 'keys' | 'phones' | 'computers';
export interface ReclaimNotice { cut: ReclaimCut[]; passwordCleared: boolean }

const KNOWN: readonly ReclaimCut[] = ['sessions', 'providers', 'two_step', 'keys', 'phones', 'computers'];

/** The notice out of a `/api/auth/me` body (envelope or bare): anything that is not exactly the server's shape is «nothing to show». */
export function reclaimNoticeOf(body: unknown): ReclaimNotice | null {
  const data = (body as { data?: unknown } | null)?.data ?? body;
  const n = (data as { reclaim_notice?: unknown } | null)?.reclaim_notice;
  if (!n || typeof n !== 'object') return null;
  const { cut, password_cleared: pw } = n as { cut?: unknown; password_cleared?: unknown };
  if (!Array.isArray(cut)) return null;
  const known = KNOWN.filter((k) => cut.includes(k)); // the server's order, only names this page knows
  const passwordCleared = pw === true;
  return known.length > 0 || passwordCleared ? { cut: known, passwordCleared } : null;
}

export function ReclaimNoticeAlert() {
  const t = useTranslations('reclaimNotice');
  const tLogin = useTranslations('login');
  const tCommon = useTranslations('common');
  const [notice, setNotice] = useState<ReclaimNotice | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    let off = false;
    void fetchWithAuth('/api/auth/me', { cache: 'no-store' })
      .then(async (res) => (res.ok ? await res.json() : null))
      .then((body) => { if (!off) setNotice(reclaimNoticeOf(body)); })
      .catch(() => undefined); // not knowing is «nothing to show» — the notice stays on the server for the next load
    return () => { off = true; };
  }, []);

  if (!notice) return null;

  const names: string[] = [];
  if (notice.cut.includes('sessions')) names.push(t('items.sessions'));
  if (notice.cut.includes('providers')) names.push(t('items.providers'));
  if (notice.cut.includes('two_step')) names.push(t('items.twoStep'));
  if (notice.cut.includes('keys')) names.push(t('items.keys'));
  const phones = notice.cut.includes('phones');
  const computers = notice.cut.includes('computers');
  if (phones && computers) names.push(t('items.phonesAndComputers'));
  else if (phones) names.push(t('items.phones'));
  else if (computers) names.push(t('items.computers'));
  // the joiners are copy (ko « · » all through; en «a, b, and c» / «a and b») — no locale is read here
  const items = names.length <= 2
    ? names.join(t('items.pairJoin'))
    : `${names.slice(0, -1).join(t('items.join'))}${t('items.lastJoin')}${names[names.length - 1]}`;

  const close = async () => {
    setClosing(true);
    try {
      const res = await fetchWithAuth('/api/auth/reclaim-notice/dismiss', { method: 'POST' });
      if (res.ok) { setNotice(null); return; }
    } catch {
      /* the mark stays on the server: the notice stays here and the button can be pressed again */
    }
    setClosing(false);
  };

  return (
    <Alert variant="info" role="status" data-testid="reclaim-notice">
      <Info className="h-4 w-4 text-info" aria-hidden />
      <AlertTitle>{t('title')}</AlertTitle>
      <AlertDescription>
        {names.length > 0 ? <span className="block break-keep">{t('body', { items, eulReul: pickEulReulJosa(items) })}</span> : null}
        {notice.passwordCleared ? <span className="block break-keep">{t('passwordLine', { forgot: tLogin('forgotPassword') })}</span> : null}
      </AlertDescription>
      <div className="col-start-2 mt-2 flex justify-end">
        <Button type="button" variant="outline" size="sm" className="whitespace-nowrap" disabled={closing} onClick={() => void close()} data-testid="reclaim-notice-close">
          {tCommon('close')}
        </Button>
      </div>
    </Alert>
  );
}
