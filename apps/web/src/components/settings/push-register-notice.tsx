'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { isSupportWidgetEnabled } from '@/lib/support-widget-flag';
import { pickEuroJosa } from '@/lib/korean-particle';
import {
  isPushRetryPending, readPushRegisterFailure, requestPushRetry, subscribePushRegister, type PushRegisterFailed,
} from '@/lib/native-shell-bridge';

// story #4694 AC2 ② (copy sheet: yuna/4694-ac2-push-register-copy-1019) — the phone says «this phone could not be registered for
// notifications» and lets the person retry. One quiet line + one button in Settings › Notifications; nothing is drawn when the
// registration is fine, in a browser, or when the shell gave no state. Not red (a state to mend, not a mistake of the person),
// role=status (it is there when the page opens), a success removes the line with no toast. The retry button is the default size (44px touch target):
// it is the only action of a line that shows only in the phone app. «으로/로» after the tab name is picked from its last syllable, not fixed in the text.
//  · cause «permission» → the «off» line · everything else → the general line (the two never both)
//  · the button reads «등록하는 중이에요…» and is off while the shell's attempt is out (one registration per press — the bridge holds that)
//  · after a failed retry of the general cause only, one more sentence (the permission line already says what to do): «close the app and open it again»,
//    and «tell us from Settings › Contact & Support» only where that tab exists

// The shell's state lives outside React (window.__SPRINTABLE_SHELL__ + the bridge module's «pending») — read as an external store.
// The snapshot is a string (stable while nothing changed); the server snapshot is «nothing».
const snapshot = () => JSON.stringify({ v: readPushRegisterFailure(), p: isPushRetryPending() });
const serverSnapshot = () => JSON.stringify({ v: null, p: false });

export function PushRegisterNotice() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { v: view, p: busy } = JSON.parse(useSyncExternalStore(subscribePushRegister, snapshot, serverSnapshot)) as { v: PushRegisterFailed | null; p: boolean };

  if (!view) return null;
  return (
    <div role="status" className="mb-4 rounded-md border border-border bg-muted/20 px-3 py-2.5" data-testid="push-register-notice">
      <p className="break-keep text-sm text-foreground">{view.cause === 'permission' ? t('pushRegisterOff') : t('pushRegisterFailed')}</p>
      {view.cause === 'other' && view.retried ? (
        <p className="mt-1 break-keep text-sm text-muted-foreground">
          {t('pushRegisterStillFailed')}
          {/* the «Contact & Support» tab exists only where the support widget is on (production has it off) — never point at a tab that is not there */}
          {isSupportWidgetEnabled() ? ` ${t('pushRegisterContactSupport', { support: t('tabSupport'), josa: pickEuroJosa(t('tabSupport')) })}` : ''}
        </p>
      ) : null}
      <Button type="button" variant="outline" className="mt-2 whitespace-nowrap" disabled={busy} onClick={requestPushRetry}>
        {busy ? t('pushRegisterBusy') : tc('retry')}
      </Button>
    </div>
  );
}
