'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Circle } from 'lucide-react';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';

function checkPasswordRules(pw: string) {
  return {
    length: pw.length >= 8,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    digit: /\d/.test(pw),
    special: /[^A-Za-z0-9]/.test(pw),
  };
}

function countCategories(rules: ReturnType<typeof checkPasswordRules>) {
  return [rules.upper, rules.lower, rules.digit, rules.special].filter(Boolean).length;
}

// story #3155(#3149 조사 중 발견 — 원조 갭) — linked-accounts-section.tsx가 "SetPasswordSection과
// 동일 컨벤션 유지"라고 명시했을 만큼 이쪽이 하드코딩 영문의 원조였다. next-intl로 이관
// (`setPassword*`, linkedAccounts*와 동형 컨벤션). has_password=false(소셜 로그인 전용)일 때만
// 렌더돼 노출 빈도가 낮았을 뿐, 소셜 온보딩 신규 사용자에겐 정확히 이 조건이 걸린다.
export function SetPasswordSection() {
  const t = useTranslations('settings');
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // story #ab2a503f(2026-09-01) — set-password가 재인증 게이트(이메일 확인 2단계)로
  // 바뀌었다: request 성공은 "완료"가 아니라 "메일함을 확인하세요"다(실제 write는 이메일
  // 링크 클릭이 여는 /set-password/confirm 페이지가 한다). requested=true는 폼을 감추고
  // 그 안내로 치환한다 — has_password는 그 클릭이 있기 전까진 여전히 false라 페이지를
  // 새로고침하면 폼이 다시 보인다(forgot-password 페이지와 동일 관례, 별도 영속 불필요).
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetchWithAuth('/api/me');
      if (!res.ok) return;
      const json = await res.json() as { data?: { has_password?: boolean } };
      setHasPassword(json.data?.has_password ?? null);
    })();
  }, []);

  // has_password 필드 없거나 true면 렌더링하지 않는
  if (hasPassword !== false) return null;

  const rules = checkPasswordRules(password);
  const categoriesMet = countCategories(rules);
  const isPasswordValid = rules.length && categoriesMet >= 3;
  const isConfirmValid = confirm === password;
  const showRules = touched && password.length > 0;

  const handleSubmit = async () => {
    setTouched(true);
    if (!isPasswordValid || !isConfirmValid || !password) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/set-password/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: password }),
      });
      const json = await res.json() as { data?: { delivered?: boolean }; error?: { code?: string; message: string } };
      if (!res.ok) {
        // story #2485 — code로 분기(backend auth.py request_set_password()가 _err()로
        // 직접 발급하는 안정 값). 알려지지 않은 code만 안전 폴백.
        if (json.error?.code === 'ALREADY_HAS_PASSWORD') {
          setMessage({ type: 'error', text: t('setPasswordErrorAlreadyHasPassword') });
        } else if (json.error?.code === 'USER_NOT_FOUND') {
          setMessage({ type: 'error', text: t('setPasswordErrorUserNotFound') });
        } else {
          setMessage({ type: 'error', text: t('setPasswordErrorGeneric') });
        }
        return;
      }
      // story #ab2a503f — delivered:false를 "완료"로 거짓 보고하지 않는다(BE의 정직 응답
      // 그대로 반영, resend-verification·verify-email과 동일 관례).
      if (json.data?.delivered === false) {
        setMessage({ type: 'error', text: t('setPasswordRequestUndelivered') });
        return;
      }
      setRequested(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('setPasswordTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('setPasswordDescription')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {requested ? (
          <p role="status" aria-live="polite" aria-atomic="true" className="text-sm text-success">
            {t('setPasswordRequestSuccessDelivered')}
          </p>
        ) : (
          <>
            {message && (
              // story #2105 2차 — handleSubmit이 재시도 전 setMessage(null)을 먼저 호출해(위 정의) 매
              // 시도마다 언마운트→리마운트된다. 에러=alert/assertive, 성공=status/polite.
              <p
                role={message.type === 'success' ? 'status' : 'alert'}
                aria-live={message.type === 'success' ? 'polite' : 'assertive'}
                aria-atomic="true"
                className={`text-sm ${message.type === 'success' ? 'text-success' : 'text-destructive'}`}
              >
                {message.text}
              </p>
            )}

            <div className="space-y-3 max-w-sm">
              <input
                type="password"
                placeholder={t('setPasswordPlaceholderNew')}
                autoComplete="new-password"
                className={`w-full rounded-lg border px-4 py-2 text-sm text-foreground bg-background focus:outline-none focus:ring-2 focus:ring-primary ${
                  showRules && !isPasswordValid ? 'border-destructive' : 'border-border'
                }`}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setTouched(true); }}
                disabled={busy}
              />
              <input
                type="password"
                placeholder={t('setPasswordPlaceholderConfirm')}
                autoComplete="new-password"
                className={`w-full rounded-lg border px-4 py-2 text-sm text-foreground bg-background focus:outline-none focus:ring-2 focus:ring-primary ${
                  touched && confirm && !isConfirmValid ? 'border-destructive' : 'border-border'
                }`}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
              />

              {showRules && (
                <ul className="divide-y divide-border text-xs">
                  <PasswordRuleItem met={rules.length} label={t('setPasswordRuleLength')} />
                  <li className={`flex items-center gap-1.5 py-1.5 ${categoriesMet >= 3 ? 'text-success' : 'text-muted-foreground'}`}>
                    {categoriesMet >= 3 ? <Check className="size-3.5 shrink-0" /> : <Circle className="size-3.5 shrink-0" />}
                    <span>{t('setPasswordRuleCategories', { count: categoriesMet })}</span>
                  </li>
                </ul>
              )}

              {touched && confirm && !isConfirmValid && (
                <p className="text-xs text-destructive">{t('setPasswordMismatch')}</p>
              )}

              <button
                onClick={() => void handleSubmit()}
                disabled={busy || !password || !confirm}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? t('setPasswordSubmitting') : t('setPasswordSubmit')}
              </button>
            </div>
          </>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}

function PasswordRuleItem({ met, label }: { met: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 py-1.5 ${met ? 'text-success' : 'text-muted-foreground'}`}>
      {met ? <Check className="size-3.5 shrink-0" /> : <Circle className="size-3.5 shrink-0" />}
      <span>{label}</span>
    </li>
  );
}
