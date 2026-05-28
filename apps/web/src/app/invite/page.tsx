'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { SprintableLogo } from '@/components/brand/sprintable-logo';
import { cn } from '@/lib/utils';

interface InvitePreview {
  org_id: string;
  org_name: string;
  inviter_name: string;
  inviter_email?: string;
  role: 'admin' | 'member';
  expires_at: string;
  invited_email: string;
}

type AuthMode = 'signup' | 'login';
type PageState = 'preview-loading' | 'preview-error' | 'auth' | 'accepting' | 'success';

export default function InvitePage() {
  const t = useTranslations('invite');
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');

  const [pageState, setPageState] = useState<PageState>('preview-loading');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');

  const [authMode, setAuthMode] = useState<AuthMode>('signup');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tosAccepted, setTosAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setPageState('preview-error');
      setErrorMsg(t('invalidToken'));
      return;
    }
    fetch(`/api/invitations/preview?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
          throw new Error(json?.error?.message ?? 'preview failed');
        }
        const json = await res.json() as { data: InvitePreview };
        setPreview(json.data);
        if (json.data.invited_email) setEmail(json.data.invited_email);
        const meRes = await fetch('/api/me');
        if (meRes.ok) {
          void acceptInvite(token);
        } else {
          setPageState('auth');
        }
      })
      .catch((err: Error) => {
        setPageState('preview-error');
        setErrorMsg(err.message);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const acceptInvite = async (inviteToken: string) => {
    setPageState('accepting');
    const res = await fetch('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken }),
    });
    if (res.ok) {
      setPageState('success');
      setTimeout(() => router.push('/dashboard'), 1500);
    } else {
      const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setPageState('preview-error');
      setErrorMsg(json?.error?.message ?? t('acceptFailed'));
    }
  };

  const handleSubmit = async () => {
    if (!token || submitting) return;
    if (authMode === 'signup') {
      if (!displayName.trim() || !email.trim() || !password.trim() || !tosAccepted) return;
    } else {
      if (!email.trim() || !password.trim()) return;
    }
    setSubmitting(true);
    setErrorMsg('');
    try {
      const endpoint = authMode === 'signup' ? '/api/auth/register' : '/api/auth/login';
      const body = authMode === 'signup'
        ? {
            email: email.trim(),
            password,
            display_name: displayName.trim(),
            tos_accepted: true,
            invite_token: token,
          }
        : { email: email.trim(), password };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setErrorMsg(json?.error?.message ?? t('authFailed'));
        return;
      }
      if (authMode === 'signup') {
        setPageState('success');
        setTimeout(() => router.push('/dashboard'), 1500);
      } else {
        await acceptInvite(token);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (pageState === 'preview-loading') {
    return (
      <Frame>
        <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="text-sm">{t('loading')}</p>
        </div>
      </Frame>
    );
  }

  if (pageState === 'preview-error') {
    return (
      <Frame>
        <div className="space-y-3 py-8 text-center">
          <div className="text-3xl">✕</div>
          <p className="text-sm text-destructive">{errorMsg}</p>
          <a href="/login" className="text-sm font-medium text-brand hover:text-brand/80">
            로그인 페이지로 →
          </a>
        </div>
      </Frame>
    );
  }

  if (pageState === 'accepting' || pageState === 'success') {
    return (
      <Frame>
        <div className="space-y-3 py-8 text-center animate-in fade-in duration-500">
          <Loader2 className={cn(
            'mx-auto h-6 w-6',
            pageState === 'accepting' && 'animate-spin text-muted-foreground',
            pageState === 'success' && 'text-success',
          )} />
          {pageState === 'success' && preview ? (
            <>
              <p className="text-lg font-semibold tracking-tight text-foreground">
                {preview.org_name}에 합류했어요
              </p>
              <p className="text-sm text-muted-foreground">{t('redirecting')}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('accepting')}</p>
          )}
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      {preview && (
        <div className="space-y-6">
          <div className="space-y-3 text-center animate-in fade-in slide-in-from-bottom-2 duration-500 delay-100 fill-mode-backwards">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              <span className="block">{preview.org_name}</span>
              <span className="block text-base font-normal text-muted-foreground mt-1">
                에 합류하세요
              </span>
            </h1>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm animate-in fade-in slide-in-from-bottom-2 duration-500 delay-200 fill-mode-backwards">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">
                  {preview.inviter_name}님이 초대했어요
                </div>
                {preview.inviter_email && (
                  <div className="truncate text-xs text-muted-foreground">{preview.inviter_email}</div>
                )}
              </div>
              <span className="shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-xs capitalize text-muted-foreground">
                {preview.role}
              </span>
            </div>
          </div>

          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500 delay-300 fill-mode-backwards">
            <div className="flex gap-1 border-b border-border">
              {(['signup', 'login'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => { setAuthMode(mode); setErrorMsg(''); }}
                  className={cn(
                    'relative -mb-px px-3 py-2 text-sm font-medium transition-colors',
                    authMode === mode
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground/80',
                  )}
                >
                  {mode === 'signup' ? '가입' : '로그인'}
                  {authMode === mode && (
                    <span className="absolute inset-x-0 -bottom-px h-0.5 bg-foreground" />
                  )}
                </button>
              ))}
            </div>

            <div className="space-y-3">
              {authMode === 'signup' && (
                <input
                  type="text"
                  placeholder="이름"
                  autoComplete="name"
                  className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-brand"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={submitting}
                />
              )}
              <input
                type="email"
                placeholder="이메일"
                autoComplete="email"
                className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-brand"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
              <input
                type="password"
                placeholder="비밀번호"
                autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-brand"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void handleSubmit()}
                disabled={submitting}
              />
              {authMode === 'signup' && (
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={tosAccepted}
                    onChange={(e) => setTosAccepted(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-brand"
                    disabled={submitting}
                  />
                  <span className="text-xs text-muted-foreground">
                    이용약관 + 개인정보처리방침에 동의합니다
                  </span>
                </label>
              )}
            </div>

            {errorMsg && (
              <p className="text-sm text-destructive">{errorMsg}</p>
            )}

            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || (authMode === 'signup'
                ? (!displayName.trim() || !email.trim() || !password.trim() || !tosAccepted)
                : (!email.trim() || !password.trim()))}
              className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {submitting ? '...' : '합류하기'}
            </button>
          </div>

          <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-500 delay-400 fill-mode-backwards">
            <div className="relative flex items-center">
              <div className="flex-grow border-t border-border/50" />
              <span className="mx-3 flex-shrink text-xs text-muted-foreground/60">또는</span>
              <div className="flex-grow border-t border-border/50" />
            </div>
            <a
              href={`/auth/login?provider=google&invite_token=${encodeURIComponent(token!)}&tos_accepted=true`}
              className="flex w-full min-h-[44px] items-center justify-center gap-3 rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium text-foreground/80 transition hover:bg-muted/50"
            >
              <GoogleIcon />
              Google로 계속
            </a>
            <a
              href={`/auth/login?provider=github&invite_token=${encodeURIComponent(token!)}&tos_accepted=true`}
              className="flex w-full min-h-[44px] items-center justify-center gap-3 rounded-lg border border-border bg-foreground px-4 py-3 text-sm font-medium text-background transition hover:bg-foreground/90"
            >
              <GitHubIcon />
              GitHub로 계속
            </a>
          </div>
        </div>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,_var(--brand)_/_0.08,_transparent_60%)]"
      />
      <div className="relative w-full max-w-md space-y-8 rounded-2xl border border-border bg-background/95 p-6 shadow-xl shadow-foreground/[0.02] backdrop-blur sm:p-8">
        <div className="flex justify-center animate-in fade-in duration-500">
          <SprintableLogo variant="stacked" className="text-foreground" markClassName="h-10" wordmarkClassName="h-4" />
        </div>
        {children}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}
