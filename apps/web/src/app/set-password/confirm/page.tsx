'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SprintableLogo } from '@/components/brand/sprintable-logo';
import { useFlatHref } from '@/hooks/use-flat-href';

// story #ab2a503f([버그·보안·HIGH] set-password 재인증 게이트) — 이메일 확인 링크가 여는
// 2단계 페이지. verify-email/page.tsx와 동형 구조. confirm은 새 세션 토큰을 발급하지
// 않으므로(BE 설계 doc §① — "이 요청 자체가 인증 세션이 아님") "시작하기" 없이 로그인
// 페이지 안내만 준다.
//
// 유나 design:changes(PR#3688, 2026-09-01) — 세 방어:
// ①success에 «다른 기기 로그아웃»(BE가 confirm 성공 시 refresh token 전량 revoke하는데
//   화면에 그 안내가 없어 사용자가 놀랄 수 있음).
// ②INVALID_TOKEN(만료) 화면에 재요청 동선(/login만 있던 걸 /settings로 확장 — 재요청은
//   인증 필요라 무인증 페이지에서 직접 재발송은 불가, 로그인 후 설정에서 재시도 안내).
// ③ALREADY_HAS_PASSWORD는 실패가 아니라 「이미 완료」라 빨강(destructive)이 부적절 —
//   중립 톤(neutral status) 전용.
export default function SetPasswordConfirmPage() {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('setPassword');
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [status, setStatus] = useState<'loading' | 'success' | 'neutral' | 'error'>(
    () => (token ? 'loading' : 'error')
  );
  const [message, setMessage] = useState(
    () => (token ? '' : t('invalidLink'))
  );
  // INVALID_TOKEN(만료)일 때만 /settings 재요청 동선을 보여준다 — 다른 실패는 재요청으로
  // 해결되지 않는 사유라(USER_NOT_FOUND 등) 오히려 오도.
  const [showRetryLink, setShowRetryLink] = useState(false);

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
          // ⭐유나 design:changes ① — BE가 confirm 성공 시 활성 refresh token 전량을
          // revoke한다(탈취 refresh token 우회 봉합). 그 부수효과(다른 기기 로그아웃)를
          // 사용자가 놀라지 않게 명시.
          setMessage(t('successMessage'));
        } else if (json.error?.code === 'ALREADY_HAS_PASSWORD') {
          // ⭐유나 design:changes ③ — 실패가 아니라 「이미 완료」. 중립 톤.
          setStatus('neutral');
          setMessage(t('alreadySet'));
        } else {
          setStatus('error');
          // backend auth.py confirm_set_password()가 _err()로 직접 발급하는 안정 값만
          // 분기(raw 서버 message 미노출 — verify-email/page.tsx와 동일 관례).
          if (json.error?.code === 'INVALID_TOKEN') {
            setMessage(t('linkExpired'));
            setShowRetryLink(true); // ⭐유나 design:changes ②
          } else if (json.error?.code === 'USER_NOT_FOUND') {
            setMessage(t('userNotFound'));
          } else {
            setMessage(t('setFailed'));
          }
        }
      })
      .catch(() => {
        setStatus('error');
        setMessage(t('processError'));
      });
  }, [token, t]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8 text-center">
        <div className="flex flex-col items-center gap-3">
          <SprintableLogo variant="stacked" className="text-foreground" markClassName="h-14" wordmarkClassName="h-5" />
        </div>

        {status === 'loading' && (
          <p className="text-sm text-muted-foreground">{t('settingUp')}</p>
        )}

        {status === 'success' && (
          <div className="space-y-4">
            <p className="text-sm font-medium text-success" role="status" aria-live="polite" aria-atomic="true">{message}</p>
            <Link href="/login" className="block text-sm font-medium text-brand-text hover:text-brand-text/85">
              {t('loginButton')}
            </Link>
          </div>
        )}

        {status === 'neutral' && (
          <div className="space-y-4">
            <p className="text-sm font-medium text-foreground" role="status" aria-live="polite" aria-atomic="true">{message}</p>
            <Link href="/login" className="block text-sm font-medium text-brand-text hover:text-brand-text/85">
              {t('loginButton')}
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-4">
            <p className="text-sm text-destructive" role="alert" aria-live="assertive" aria-atomic="true">{message}</p>
            {showRetryLink && (
              <Link href={flatHref('/settings')} className="block text-sm font-medium text-brand-text hover:text-brand-text/85">
                {t('retryLink')}
              </Link>
            )}
            <Link href="/login" className="block text-sm font-medium text-brand-text hover:text-brand-text/85">
              {t('backToLogin')}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
