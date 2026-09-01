'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

// story #ab2a503f([버그·보안·HIGH] set-password 재인증 게이트) — 이메일 확인 링크가 여는
// 2단계 페이지. verify-email/page.tsx와 동형(next-intl 미배선, 하드코딩 한국어 — 그 페이지의
// "Phase2 i18n" 유보와 동일 스코프 판단). confirm은 새 세션 토큰을 발급하지 않으므로(BE 설계
// doc §① — "이 요청 자체가 인증 세션이 아님") "시작하기" 없이 로그인 페이지 안내만 준다.
export default function SetPasswordConfirmPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>(
    () => (token ? 'loading' : 'error')
  );
  const [message, setMessage] = useState(
    () => (token ? '' : '유효하지 않은 확인 링크입니다.')
  );

  useEffect(() => {
    if (!token) return;

    fetch('/api/auth/set-password/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((res) => res.json())
      .then((json: { data?: { message: string }; error?: { code?: string; message: string } }) => {
        if (json.data) {
          setStatus('success');
          setMessage('비밀번호가 설정되었습니다. 새 비밀번호로 로그인해 주세요.');
        } else {
          setStatus('error');
          // backend auth.py confirm_set_password()가 _err()로 직접 발급하는 안정 값만
          // 분기(raw 서버 message 미노출 — verify-email/page.tsx와 동일 관례).
          if (json.error?.code === 'INVALID_TOKEN') {
            setMessage('확인 링크가 유효하지 않거나 만료되었습니다.');
          } else if (json.error?.code === 'USER_NOT_FOUND') {
            setMessage('사용자를 찾을 수 없습니다.');
          } else if (json.error?.code === 'ALREADY_HAS_PASSWORD') {
            setMessage('이미 비밀번호가 설정되어 있습니다.');
          } else {
            setMessage('비밀번호 설정에 실패했습니다.');
          }
        }
      })
      .catch(() => {
        setStatus('error');
        setMessage('처리 중 오류가 발생했습니다.');
      });
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8 text-center">
        <div className="flex flex-col items-center gap-3">
          <SprintableLogo variant="stacked" className="text-foreground" markClassName="h-14" wordmarkClassName="h-5" />
        </div>

        {status === 'loading' && (
          <p className="text-sm text-muted-foreground">비밀번호 설정 중...</p>
        )}

        {status === 'success' && (
          <div className="space-y-4">
            <p className="text-sm font-medium text-success" role="status" aria-live="polite" aria-atomic="true">{message}</p>
            <Link href="/login" className="block text-sm font-medium text-brand hover:text-brand/80">
              로그인하기
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-4">
            <p className="text-sm text-destructive" role="alert" aria-live="assertive" aria-atomic="true">{message}</p>
            <Link href="/login" className="block text-sm font-medium text-brand hover:text-brand/80">
              로그인으로 돌아가기
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
