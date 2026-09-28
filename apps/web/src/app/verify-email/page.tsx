'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

export default function VerifyEmailPage() {
  const t = useTranslations('verifyEmail');
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token') ?? '';

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>(
    () => (token ? 'loading' : 'error')
  );
  const [message, setMessage] = useState(
    () => (token ? '' : t('invalidLink'))
  );

  // story #3195 — «시작하기»가 org 유무와 무관하게 항상 /inbox로 갔다. 온보딩 도중(org
  // 미생성) 이메일 인증 벽에 걸린 유저는 org가 없어 /inbox가 막다른 곳이었다(온보딩
  // 1/4로 돌아가야 sessionStorage draft도 복원된다) — register/page.tsx와 동일 패턴
  // (org_id 유무로 목적지 분기)으로 통일.
  //
  // 카디르 QA(PR#3617) 치명 — `/api/me`는 BE `me.py::get_me()`(TeamMember 필수)를 서빙해
  // 무 org(정확히 이 유저 상태)면 404 → org_id를 못 읽어 `/inbox` 폴백으로 떨어지며 막다른
  // 길이 재생산됐다. `/api/auth/me`(BFF 신설, BE app.routers.auth.get_auth_me)로 교체 —
  // JWT claims만 읽어 org 유무와 무관하게 항상 200.
  //
  // 유나 design:pass 비차단 ①(2026-08-29) — 응답 前 빠른 클릭이면 no-org 유저가 여전히
  // 막다른 /inbox로 갈 수 있었다(useState 기본값 레이스). ref에 Promise를 캐시해 effect든
  // 클릭이든 «같은 promise»를 공유·await하게 해 판정 前 클릭도 정확한 목적지를 기다렸다
  // 라우팅한다(중복 fetch도 안 남).
  const destinationRef = useRef<Promise<string> | null>(null);
  function resolveDestination(): Promise<string> {
    if (!destinationRef.current) {
      destinationRef.current = fetch('/api/auth/me')
        .then((res) => (res.ok ? res.json() : null))
        .then((json: { data?: { org_id?: string | null } } | null) => (json?.data?.org_id ? '/inbox' : '/onboarding'))
        .catch(() => '/inbox'); // 조회 실패는 이전 동작(/inbox)으로 저하
    }
    return destinationRef.current;
  }
  useEffect(() => { void resolveDestination(); }, []);

  const handleStart = () => {
    void resolveDestination().then((destination) => router.push(destination));
  };

  useEffect(() => {
    if (!token) return;

    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((res) => res.json())
      .then((json: { data?: { message: string }; error?: { code?: string; message: string } }) => {
        if (json.data) {
          setStatus('success');
          // story #2484 — 유나 design:changes(2026-08-06): 성공 분기도 raw 서버 message를
          // 그대로 노출했다("Email verified successfully"/"Email already verified" 둘
          // 다 하드코딩 영문). 성공은 code가 없어 분기 불가하니 우리 자체 한국어 문구
          // 하나로 통일한다(신규/기존 인증 둘 다 "인증됨" 결과는 동일하므로 구분 불요).
          setMessage(t('verifiedSuccess'));
        } else {
          setStatus('error');
          // story #2484 — code로 분기(backend auth.py verify_email()이 _err()로 직접
          // 발급하는 안정 값). 알려지지 않은 code만 안전 폴백(raw message 미노출).
          // story #3921 — next-intl은 root layout이 전역 제공 중이라(#2485 당시의
          // "미배선" 전제가 틀렸다) t() 키로 전환. raw 서버 노출 없음은 그대로 유지.
          if (json.error?.code === 'INVALID_TOKEN') {
            setMessage(t('linkExpired'));
          } else if (json.error?.code === 'USER_NOT_FOUND') {
            setMessage(t('userNotFound'));
          } else {
            setMessage(t('verifyFailed'));
          }
        }
      })
      .catch(() => {
        setStatus('error');
        setMessage(t('verifyError'));
      });
  }, [token, t]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8 text-center">
        <div className="flex flex-col items-center gap-3">
          <SprintableLogo variant="stacked" className="text-foreground" markClassName="h-14" wordmarkClassName="h-5" />
        </div>

        {status === 'loading' && (
          <p className="text-sm text-muted-foreground">{t('verifying')}</p>
        )}

        {status === 'success' && (
          <div className="space-y-4">
            <p className="text-sm font-medium text-success" role="status" aria-live="polite" aria-atomic="true">{message}</p>
            <button
              onClick={handleStart}
              className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90"
            >
              {t('startButton')}
            </button>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-4">
            <p className="text-sm text-destructive" role="alert" aria-live="assertive" aria-atomic="true">{message}</p>
            <Link href="/login" className="block text-sm font-medium text-brand-text hover:text-brand-text/85">
              {t('backToLogin')}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
