'use client';
// story 4773 (AC3) — Today, inside the phone app, for a phone that is paired with nothing: one line and one link to the pairing screen (`/desktop/pair`, the
// address the phone's start screen already uses). From Today that is card → [Scan QR] = two presses to the camera; it was eight (More → find a screen by name →
// Desktop app → scroll → «Pair with a computer» → Scan QR).
// «Paired with nothing» is the start screen's own read (`readStartableKeyed`: the shell's `key_number` looked up on the server's list of this person's phones): `no_phone` — and
// `no_screen_lock`, which the start screen also treats as «no Mac yet» (the pairing page says why a phone without a screen lock cannot pair). Anything else — still reading,
// a failed read, a phone that is paired, not the phone app — draws nothing: no flash, no line that may be untrue.
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { usePairHref } from '@/hooks/use-pair-href';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { readStartableKeyed } from '@/lib/phone-start';

export function TodayPairCard() {
  const t = useTranslations('phonePairing');
  const pairHref = usePairHref(); // story 4780: carries this page (Today) so the pairing screen's [Close] comes back here
  const { inPhoneApp, phoneCall } = usePhoneBridge();
  // the answer is stored with the bridge it came from: another bridge makes an old answer «not read yet» without a state write in the effect
  const [seen, setSeen] = useState<{ call: typeof phoneCall; unpaired: boolean } | null>(null);
  // restored from the back-forward cache (the person paired on /desktop/pair and came back with Back): the page is as it was left, the old answer on it — read again (the start screen does the same).
  // The old answer stays on screen until the new one lands: a phone that is still unpaired sees no flash, a phone that has just paired loses the card.
  const [restored, setRestored] = useState(0);
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) setRestored((n) => n + 1); };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);
  // one read per bridge and per restore: React may run the effect twice (StrictMode · a remount) and the read asks the shell for the phone's key (it makes one if the phone has none) — the second run shares the first run's read
  const read = useRef<{ call: typeof phoneCall; restored: number; unpaired: Promise<boolean> } | null>(null);

  useEffect(() => {
    if (!inPhoneApp) return;
    let stale = false;
    if (read.current?.call !== phoneCall || read.current.restored !== restored) {
      read.current = {
        call: phoneCall,
        restored,
        unpaired: readStartableKeyed(phoneCall).then((r) => r.kind === 'no_phone' || r.kind === 'no_screen_lock', () => false), // a read that throws is a failed read: no card
      };
    }
    void read.current.unpaired.then((unpaired) => { if (!stale) setSeen({ call: phoneCall, unpaired }); });
    return () => { stale = true; };
  }, [inPhoneApp, phoneCall, restored]);

  if (!inPhoneApp || !seen || seen.call !== phoneCall || !seen.unpaired) return null;
  return (
    <Card className="break-keep flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="today-pair-card">
      <p className="text-sm text-foreground" data-testid="today-pair-note">{t('todayNote')}</p>
      <Button asChild size="sm" className="self-start sm:self-auto">
        <a href={pairHref} data-testid="today-pair-link">{t('entry')}</a>
      </Button>
    </Card>
  );
}
