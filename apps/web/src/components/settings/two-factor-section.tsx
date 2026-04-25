'use client';

import { useEffect, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

type TwoFaState = 'loading' | 'disabled' | 'enrolling' | 'enabled';

export function TwoFactorSection() {
  const supabase = createSupabaseBrowserClient();
  const [state, setState] = useState<TwoFaState>('loading');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.mfa.listFactors();
      const enabled = (data?.totp?.length ?? 0) > 0 && data?.totp?.[0]?.status === 'verified';
      setState(enabled ? 'enabled' : 'disabled');
    })();
  }, [supabase]);

  const handleSetup = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/2fa/setup', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) { setMessage({ type: 'error', text: json.error ?? 'Setup failed' }); return; }
      setFactorId(json.data.factor_id);
      setQrCode(json.data.qr_code);
      setSecret(json.data.secret);
      setState('enrolling');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    if (!factorId || otpCode.length !== 6) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factor_id: factorId, code: otpCode }),
      });
      const json = await res.json();
      if (!res.ok) { setMessage({ type: 'error', text: json.error ?? 'Invalid code' }); return; }
      setState('enabled');
      setQrCode(null);
      setSecret(null);
      setOtpCode('');
      setMessage({ type: 'success', text: '2FA enabled successfully.' });
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
      const json = await res.json();
      if (!res.ok) { setMessage({ type: 'error', text: json.error ?? 'Invalid code' }); return; }
      setState('disabled');
      setOtpCode('');
      setMessage({ type: 'success', text: '2FA disabled.' });
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') return null;

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">🔐 Two-Factor Authentication</h2>
          <p className="text-sm text-muted-foreground">
            {state === 'enabled' ? 'Two-factor authentication is active.' : 'Add an extra layer of security using a TOTP authenticator app.'}
          </p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {message && (
          <p className={`text-sm ${message.type === 'success' ? 'text-emerald-400' : 'text-rose-400'}`}>{message.text}</p>
        )}

        {state === 'disabled' && (
          <button
            onClick={handleSetup}
            disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? '...' : 'Enable 2FA'}
          </button>
        )}

        {state === 'enrolling' && qrCode && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Scan this QR code with your authenticator app, then enter the 6-digit code below.</p>
            <div className="flex justify-center" dangerouslySetInnerHTML={{ __html: qrCode }} />
            {secret && (
              <p className="text-center text-xs text-muted-foreground">
                Manual key: <span className="font-mono text-foreground">{secret}</span>
              </p>
            )}
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              className="w-full rounded-lg border border-border bg-background px-4 py-2 text-center font-mono tracking-widest text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <button
              onClick={handleVerify}
              disabled={busy || otpCode.length !== 6}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? '...' : 'Activate 2FA'}
            </button>
          </div>
        )}

        {state === 'enabled' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Enter your current authenticator code to disable 2FA.</p>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              className="w-full rounded-lg border border-border bg-background px-4 py-2 text-center font-mono tracking-widest text-foreground focus:outline-none focus:ring-2 focus:ring-rose-500"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <button
              onClick={handleDisable}
              disabled={busy || otpCode.length !== 6}
              className="rounded-lg border border-rose-500/40 px-4 py-2 text-sm font-medium text-rose-400 hover:border-rose-400 hover:text-rose-300 disabled:opacity-50"
            >
              {busy ? '...' : 'Disable 2FA'}
            </button>
          </div>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
