'use client';
// story 4762 — «설정 › 이 폰»: the phone's own check number. The web's «원격 기기» list prints «폰 확인 숫자 NNN NNN — same as the number in the phone app's
// settings › This phone → that's the phone» (`desktop.remoteDevices.confirmNumberHint`), and this is that place. The phone app computes the number from its own signing key
// (the shell's `device.key.info` → `key_number`, the same six digits the server's `confirm_number` prints for that key); the web asks the shell, shows what comes
// back and does no computing. Like the phone's start screen, asking makes the key if the phone has none yet (nothing is registered on the server by looking).
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';

/** «### ###» — the shape both ends print; anything else the shell sends is not shown as a number */
const CHECK_NUMBER = /^\d{3} \d{3}$/;

type Result = { kind: 'number'; value: string } | { kind: 'no_screen_lock' } | { kind: 'failed' };

export function ThisPhoneCard() {
  const t = useTranslations('settings');
  const { inPhoneApp, phoneCall } = usePhoneBridge();
  const [nonce, setNonce] = useState(0);
  // the answer is stored with the request it answers: a new request (nonce) makes the old answer «not read yet» without a state write in the effect
  const [answer, setAnswer] = useState<{ nonce: number; result: Result } | null>(null);

  useEffect(() => {
    if (!inPhoneApp) return;
    let stale = false;
    phoneCall('device.key.info', {})
      .then((a): Result => {
        if (a.ok && typeof a.key_number === 'string' && CHECK_NUMBER.test(a.key_number)) return { kind: 'number', value: a.key_number };
        return !a.ok && a.code === 'no_screen_lock' ? { kind: 'no_screen_lock' } : { kind: 'failed' };
      }, (): Result => ({ kind: 'failed' })) // a rejected bridge call is a failed read, not a screen stuck on «reading»
      .then((result) => { if (!stale) setAnswer({ nonce, result }); });
    return () => { stale = true; };
  }, [inPhoneApp, phoneCall, nonce]);

  if (!inPhoneApp) return null;
  const result = answer && answer.nonce === nonce ? answer.result : null;
  return (
    <Card className="break-keep flex flex-col gap-3 p-6" data-testid="this-phone-card">
      <h2 className="text-base font-semibold">{t('thisPhoneTitle')}</h2>
      {result === null && <p className="text-sm text-muted-foreground" data-testid="this-phone-reading">{t('thisPhoneReading')}</p>}
      {result?.kind === 'number' && (
        <>
          <p className="font-mono text-3xl font-semibold tracking-widest" data-testid="this-phone-number">{result.value}</p>
          <p className="text-sm text-muted-foreground" data-testid="this-phone-hint">{t('thisPhoneHint')}</p>
        </>
      )}
      {result?.kind === 'no_screen_lock' && <p className="text-sm" data-testid="this-phone-no-screen-lock">{t('thisPhoneNoScreenLock')}</p>}
      {result?.kind === 'failed' && (
        <>
          <p className="text-sm" data-testid="this-phone-failed">{t('thisPhoneFailed')}</p>
          <Button type="button" variant="outline" size="sm" className="self-start" data-testid="this-phone-retry" onClick={() => setNonce((n) => n + 1)}>
            {t('thisPhoneRetry')}
          </Button>
        </>
      )}
    </Card>
  );
}
