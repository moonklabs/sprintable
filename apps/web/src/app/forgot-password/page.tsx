'use client';

import { useState } from 'react';
import Link from 'next/link';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!email.trim()) return;
    setLoading(true);
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      setSubmitted(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SprintableLogo variant="stacked" className="text-foreground" markClassName="h-14" wordmarkClassName="h-5" />
          <h1 className="text-lg font-semibold text-foreground">비밀번호 찾기</h1>
        </div>

        {submitted ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              입력하신 이메일로 재설정 링크를 발송했습니다. 메일함을 확인해 주세요.
            </p>
            <Link href="/login" className="block text-sm font-medium text-brand hover:text-brand/80">
              로그인으로 돌아가기
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">가입하신 이메일 주소를 입력하시면 비밀번호 재설정 링크를 보내드립니다.</p>
            <input
              type="email"
              placeholder="Email"
              autoComplete="email"
              className="w-full rounded-lg border border-border px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              disabled={loading}
            />
            <button
              onClick={handleSubmit}
              disabled={loading || !email.trim()}
              className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 disabled:opacity-50"
            >
              {loading ? '전송 중...' : '재설정 링크 전송'}
            </button>
            <p className="text-center text-sm text-muted-foreground">
              <Link href="/login" className="font-medium text-brand hover:text-brand/80">
                로그인으로 돌아가기
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
