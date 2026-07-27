'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SprintableLogo } from '@/components/brand/sprintable-logo';
import { FIREBASE_AUTH_ENABLED } from '@/lib/auth/firebase-client';
import { shouldPromptTotpReenroll } from '@/lib/auth/totp-reenroll';

function checkPasswordRules(pw: string) {
  return {
    length: pw.length >= 8,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    digit: /\d/.test(pw),
    special: /[^A-Za-z0-9]/.test(pw),
  };
}

export default function ResetPasswordPage() {
  const t = useTranslations('resetPassword');
  const t2 = useTranslations('login');
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // doc firebase-auth-login-ux-blueprint §2 S3 4번(TOTP 재등록 유도) — 이중 게이팅으로 오늘
  // 완전 무해: ①클라 플래그 off(기본)면 절대 안 읽음 ②BE가 아직 totp_enabled 필드를 반환하지
  // 않아(그라운딩 확認, backend/app/routers/auth.py reset_password 현재 {"message":...}만
  // 반환) 플래그 on이어도 undefined→false로 폴백. BE가 필드를 추가하기 전까지 이 분기는
  // 절대 렌더되지 않는다 — no-fiction(없는 신호를 있는 것처럼 배선 안 함) + 라이브 무영향.
  const [totpReenrollNeeded, setTotpReenrollNeeded] = useState(false);

  const rules = checkPasswordRules(password);
  const categoriesMet = [rules.upper, rules.lower, rules.digit, rules.special].filter(Boolean).length;
  const isValid = rules.length && categoriesMet >= 3;

  const handleSubmit = async () => {
    setTouched(true);
    if (!isValid) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: password }),
      });
      const json = await res.json() as { data?: { message: string; totp_enabled?: boolean }; error?: { message: string } };
      if (!res.ok) {
        setError(json.error?.message ?? t('submitFailed'));
        return;
      }
      setTotpReenrollNeeded(shouldPromptTotpReenroll(FIREBASE_AUTH_ENABLED, json.data?.totp_enabled));
      setDone(true);
    } catch {
      setError(t('submitFailed'));
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted">
        <div className="text-center space-y-4">
          <p className="text-sm text-destructive">{t('invalidLink')}</p>
          <Link href="/forgot-password" className="text-sm text-brand hover:text-brand/80">{t2('forgotPassword')}</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SprintableLogo variant="stacked" className="text-foreground" markClassName="h-14" wordmarkClassName="h-5" />
          <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
        </div>

        {done ? (
          // story #2105 1차(AC2) — 성공 결과도 결과다. error와 달리 사용자가 막힌 상태가
          // 아니므로 흐름을 끊는 assertive가 아니라 polite로 알린다(#2096과 동일 원칙).
          <div role="status" aria-live="polite" aria-atomic="true" className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">{t('done')}</p>
            {totpReenrollNeeded && (
              <p className="text-sm text-muted-foreground">{t('mfaReenroll')}</p>
            )}
            <button
              onClick={() => router.push('/login')}
              className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90"
            >
              {t2('signIn')}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <input
              type="password"
              placeholder={t('placeholder')}
              autoComplete="new-password"
              className={`w-full rounded-lg border px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand ${
                touched && !isValid ? 'border-destructive' : 'border-border'
              }`}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setTouched(true); }}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              disabled={loading}
            />
            {touched && password.length > 0 && (
              <ul className="space-y-1 text-xs">
                <li className={rules.length ? 'text-success' : 'text-muted-foreground/60'}>
                  {rules.length ? '✓' : '○'} {t('lengthHint')}
                </li>
                <li className={categoriesMet >= 3 ? 'text-success' : 'text-muted-foreground/60'}>
                  {categoriesMet >= 3 ? '✓' : '○'} {t('strengthHint', { met: categoriesMet })}
                </li>
              </ul>
            )}
            {/* story #2105 1차 — #2096과 같은 결함클래스. setError(null)이 재시도마다 먼저
                실행돼(위 handleSubmit) 이 단락이 매번 언마운트→리마운트되므로 동일 사유가
                반복돼도 안정적으로 낭독된다. line 73(invalidLink)은 페이지 최초 렌더의
                정적 콘텐츠라(사후에 나타나는 결과가 아님) 이 대상이 아니다 — 스크린리더가
                일반 문서 읽기로 이미 커버한다. */}
            {error && <p role="alert" aria-live="assertive" aria-atomic="true" className="text-sm text-destructive">{error}</p>}
            <button
              onClick={handleSubmit}
              disabled={loading || !password}
              className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 disabled:opacity-50"
            >
              {loading ? t('submitting') : t('submit')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
