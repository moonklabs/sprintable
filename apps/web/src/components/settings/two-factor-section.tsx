'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

type TwoFaState = 'loading' | 'disabled' | 'enrolling' | 'enabled';

export function TwoFactorSection() {
  const t = useTranslations('settings');
  const [state, setState] = useState<TwoFaState>('loading');
  const [provUri, setProvUri] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Attempt setup to detect current 2FA state
    (async () => {
      const res = await fetch('/api/auth/2fa/setup', { method: 'POST' });
      const json = await res.json() as { data?: { secret: string; uri: string }; error?: { code: string } };
      if (res.status === 409 && json.error?.code === 'TOTP_ALREADY_ENABLED') {
        setState('enabled');
      } else if (res.ok && json.data) {
        setProvUri(json.data.uri);
        setSecret(json.data.secret);
        setState('enrolling');
      } else {
        setState('disabled');
      }
    })();
  }, []);

  const handleSetup = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/2fa/setup', { method: 'POST' });
      const json = await res.json() as { data?: { secret: string; uri: string }; error?: { code: string; message: string } };
      if (!res.ok) { setMessage({ type: 'error', text: json.error?.message ?? t('twoFactorSetupFailed') }); return; }
      setProvUri(json.data?.uri ?? null);
      setSecret(json.data?.secret ?? null);
      setState('enrolling');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    if (otpCode.length !== 6) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: otpCode }),
      });
      const json = await res.json() as { data?: { ok: boolean }; error?: { message: string } };
      if (!res.ok) { setMessage({ type: 'error', text: json.error?.message ?? t('twoFactorInvalidCode') }); return; }
      setState('enabled');
      setProvUri(null);
      setSecret(null);
      setOtpCode('');
      setMessage({ type: 'success', text: t('twoFactorEnabledMsg') });
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    if (otpCode.length !== 6) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: otpCode }),
      });
      const json = await res.json() as { error?: { message: string } };
      if (!res.ok) { setMessage({ type: 'error', text: json.error?.message ?? t('twoFactorInvalidCode') }); return; }
      setState('disabled');
      setOtpCode('');
      setMessage({ type: 'success', text: t('twoFactorDisabledMsg') });
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') return null;

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground"><ShieldCheck className="size-4" />{t('twoFactorTitle')}</h2>
          <p className="text-sm text-muted-foreground">
            {state === 'enabled' ? t('twoFactorActive') : t('twoFactorDescription')}
          </p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {message && (
          <p className={`text-sm ${message.type === 'success' ? 'text-success' : 'text-destructive'}`}>{message.text}</p>
        )}

        {state === 'disabled' && (
          <button
            onClick={handleSetup}
            disabled={busy}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? '...' : t('twoFactorEnable')}
          </button>
        )}

        {state === 'enrolling' && provUri && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('twoFactorEnrollHint')}</p>
            <div className="flex justify-center">
              <div className="rounded-lg bg-white p-3">
                <QRCodeSVG value={provUri} size={220} bgColor="#ffffff" fgColor="#000000" level="M" />
              </div>
            </div>
            {secret && (
              <p className="text-center text-xs text-muted-foreground">
                {t('twoFactorManualKey')} <span className="font-mono text-foreground">{secret}</span>
              </p>
            )}
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              className="w-full rounded-lg border border-border bg-background px-4 py-2 text-center font-mono tracking-widest text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <button
              onClick={handleVerify}
              disabled={busy || otpCode.length !== 6}
              className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? '...' : t('twoFactorActivate')}
            </button>
          </div>
        )}

        {state === 'enabled' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('twoFactorDisableHint')}</p>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              className="w-full rounded-lg border border-border bg-background px-4 py-2 text-center font-mono tracking-widest text-foreground focus:outline-none focus:ring-2 focus:ring-destructive"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <button
              onClick={handleDisable}
              disabled={busy || otpCode.length !== 6}
              className="rounded-lg border border-destructive px-4 py-2 text-sm font-medium text-destructive hover:border-destructive hover:text-destructive disabled:opacity-50"
            >
              {busy ? '...' : t('twoFactorDisable')}
            </button>
          </div>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
