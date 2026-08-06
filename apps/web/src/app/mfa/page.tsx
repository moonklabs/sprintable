'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

export default function MfaPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleVerify = async () => {
    if (!code.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      const json = await res.json() as { data?: { ok: boolean }; error?: { code?: string; message: string } };
      if (!res.ok || !json.data?.ok) {
        // story #2484 — code로 분기(backend auth.py totp_verify()가 _err()로 직접 발급하는
        // 안정 값). 알려지지 않은 code만 안전 폴백(raw message 미노출). ⚠️이 라우트는
        // 현재 앱 내 어떤 링크·리다이렉트도 가리키지 않는 고아 경로로 그라운딩됨(#2484) —
        // 동작 검증 실익이 낮지만 요청 스코프대로 동일 원칙 적용.
        if (json.error?.code === 'USER_NOT_FOUND') {
          setError('We could not find your account. Please sign in again.');
        } else if (json.error?.code === 'TOTP_NOT_SETUP') {
          setError('Two-factor authentication has not been set up yet.');
        } else if (json.error?.code === 'INVALID_TOTP') {
          setError('That code did not match. Please try again.');
        } else {
          setError('Invalid verification code. Please try again.');
        }
        return;
      }
      router.push('/dashboard');
    } catch {
      setError('Verification failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SprintableLogo variant="stacked" className="text-foreground" markClassName="h-14" wordmarkClassName="h-5" />
          <h1 className="text-lg font-semibold text-foreground">Two-Factor Authentication</h1>
          <p className="text-sm text-muted-foreground">Enter the 6-digit code from your authenticator app.</p>
        </div>
        <div className="space-y-3">
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            className="w-full rounded-lg border border-border px-4 py-3 text-center text-xl font-mono tracking-widest text-foreground focus:outline-none focus:ring-2 focus:ring-brand"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
            autoFocus
          />
          {/* story #2105 2차 — handleVerify가 재시도 전 setError(null)을 먼저 호출해(위 정의)
              매 시도마다 언마운트→리마운트된다(#2096/#2105 1차와 동일 원칙). */}
          {error && <p role="alert" aria-live="assertive" aria-atomic="true" className="text-sm text-destructive">{error}</p>}
          <button
            onClick={handleVerify}
            disabled={loading || code.length !== 6}
            className="w-full rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 disabled:opacity-50"
          >
            {loading ? 'Verifying...' : 'Verify'}
          </button>
        </div>
      </div>
    </div>
  );
}
