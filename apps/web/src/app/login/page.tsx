'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SprintableLogo } from '@/components/brand/sprintable-logo';
import { loginWithPassword } from '@/lib/db/client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { safeNextPath, SESSION_EXPIRED_REASON } from '@/lib/auth/session-redirect';
import { FIREBASE_AUTH_ENABLED } from '@/lib/auth/firebase-client';
import { signInAndExchangeFirebaseSession } from '@/lib/auth/firebase-login-flow';

export default function LoginPage() {
  const t = useTranslations('login');
  const router = useRouter();
  const searchParams = useSearchParams();
  const errorCode = searchParams.get('error');
  // AC3: 세션 만료로 튕긴 경우 reason 배너 + next 로 작업 경로 복귀(오픈 리다이렉트 가드).
  const sessionExpired = searchParams.get('reason') === SESSION_EXPIRED_REASON;
  const nextParam = searchParams.get('next');
  const oauthErrors: Record<string, string> = {
    oauth_init_failed: t('oauthInitFailed'),
    oauth_missing_params: t('oauthMissingParams'),
    csrf_mismatch: t('csrfMismatch'),
    oauth_no_token: t('oauthNoToken'),
    invalid_provider: t('invalidProvider'),
    // e-mobile-oauth-native-handoff-contract — 네이티브 핸드오프 issue 실패(유나 가디언 지적,
    // 신규 에러코드가 매핑 누락돼 로그인 페이지가 밋밋한 loginFailed로 후퇴할 뻔했음).
    oauth_native_issue_failed: t('oauthNativeIssueFailed'),
  };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [showTotp, setShowTotp] = useState(false);
  const [error, setError] = useState<string | null>(
    errorCode ? (oauthErrors[errorCode] ?? t('loginFailed')) : null
  );
  const [loading, setLoading] = useState(false);
  const [firebaseLoading, setFirebaseLoading] = useState(false);

  // story a0118204: 스캐폴드 — NEXT_PUBLIC_FIREBASE_AUTH_ENABLED가 꺼져있으면(기본) 버튼 자체가
  // 안 보이니 호출 불가. 켜져 있어도 서버 플래그(FIREBASE_AUTH_ISSUE_SESSION)가 꺼져있으면
  // BFF가 501을 반환 — 클라 플래그는 UX 노출 게이트일 뿐 실 발급 권위가 아니다.
  const handleFirebaseLogin = async () => {
    if (!email.trim() || !password.trim()) return;
    setFirebaseLoading(true);
    setError(null);
    try {
      const result = await signInAndExchangeFirebaseSession(email.trim(), password);
      if (result.error) {
        setError(result.error.message);
        return;
      }
      // story #1959(P2-S3) AC: 로그인 복귀 후 /login history 잔존 0 — push 는 스택에 남아
      // 복귀 화면에서 BACK 1회가 로그인 폼으로 돌아가 버린다(재제출 위험). replace 로 스왑.
      router.replace(safeNextPath(nextParam));
      router.refresh();
    } finally {
      setFirebaseLoading(false);
    }
  };

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await loginWithPassword(email.trim(), password, showTotp ? totpCode : undefined);
      if (result.error) {
        if (result.error.code === 'TOTP_REQUIRED') {
          setShowTotp(true);
          setError(t('totpRequired'));
          return;
        }
        setError(result.error.message);
        return;
      }
      // story #1959(P2-S3): 위와 동일 사유 — replace 로 /login history 잔존 방지.
      router.replace(safeNextPath(nextParam));
      router.refresh();
    } catch {
      setError(t('loginFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SprintableLogo
            variant="stacked"
            className="text-brand dark:text-white"
            markClassName="h-14"
            wordmarkClassName="h-5"
          />
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>

        {sessionExpired && (
          <Alert variant="warning">
            <AlertDescription>{t('sessionExpired')}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-3">
          <input
            type="email"
            placeholder={t('email')}
            autoComplete="email"
            className="w-full rounded-lg border border-border px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            disabled={loading}
          />
          <input
            type="password"
            placeholder={t('password')}
            autoComplete="current-password"
            className="w-full rounded-lg border border-border px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            disabled={loading}
          />
          {showTotp && (
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder={t('totpPlaceholder')}
              className="w-full rounded-lg border border-border px-4 py-3 text-center text-lg text-foreground font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-brand"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              autoFocus
              disabled={loading}
            />
          )}
          {/* story #2105 1차 — 계정 없는 사람이 제품에서 처음 만나는 화면(들어오는 경로)인데
              role·aria-live가 없어 스크린리더가 실패 사유를 안 읽었다(#2096과 같은 결함클래스).
              handleLogin/handleFirebaseLogin이 재시도 시 setError(null)을 먼저 호출해 이
              단락이 매 시도마다 언마운트→리마운트되므로(토스트의 "나타남"과 동형), 동일한
              실패 사유가 연속으로 떠도 매번 새 DOM 노드로 안착해 안정적으로 낭독된다. */}
          {error && <p role="alert" aria-live="assertive" aria-atomic="true" className="text-sm text-destructive">{error}</p>}
          <button
            onClick={handleLogin}
            disabled={loading || !email.trim() || !password.trim()}
            className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 disabled:opacity-50"
          >
            {loading ? t('signingIn') : t('signIn')}
          </button>
          {FIREBASE_AUTH_ENABLED && (
            <button
              onClick={handleFirebaseLogin}
              disabled={firebaseLoading || !email.trim() || !password.trim()}
              className="flex w-full min-h-[44px] items-center justify-center rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium text-foreground/80 transition hover:bg-muted/50 disabled:opacity-50"
            >
              {firebaseLoading ? t('signingIn') : t('firebaseSignIn')}
            </button>
          )}
        </div>

        {process.env.NEXT_PUBLIC_OAUTH_ENABLED === 'true' && (
          <div className="space-y-3">
            <div className="relative flex items-center">
              <div className="flex-grow border-t border-border/50" />
              <span className="mx-3 flex-shrink text-xs text-muted-foreground/60">{t('orContinueWith')}</span>
              <div className="flex-grow border-t border-border/50" />
            </div>

            <a href={`/auth/login?provider=google&tos_accepted=true${nextParam ? `&next=${encodeURIComponent(nextParam)}` : ''}`} className="flex w-full min-h-[44px] items-center justify-center gap-3 rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium text-foreground/80 transition hover:bg-muted/50">
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              {t('google')}
            </a>

            <p className="text-center text-xs text-muted-foreground/60">
              {t('termsPrefix')}{' '}
              <a href="/terms" target="_blank" className="underline hover:text-foreground/60">{t('termsOfService')}</a>
              {' '}{t('and')}{' '}
              <a href="/privacy" target="_blank" className="underline hover:text-foreground/60">{t('privacyPolicy')}</a>
            </p>
          </div>
        )}

        <p className="text-center text-sm text-muted-foreground">
          <Link href="/forgot-password" className="font-medium text-brand hover:text-brand/80">
            {t('forgotPassword')}
          </Link>
        </p>
        <p className="text-center text-sm text-muted-foreground">
          {t('noAccount')}{' '}
          <Link href="/register" className="font-medium text-brand hover:text-brand/80">
            {t('signUp')}
          </Link>
        </p>
      </div>
    </div>
  );
}
