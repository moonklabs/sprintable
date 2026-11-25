'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SprintableLogo } from '@/components/brand/sprintable-logo';
import { Banner } from '@/components/ds/banner';
import { Button, buttonVariants } from '@/components/ds/button';
import { Checkbox } from '@/components/ds/checkbox';
import { Input } from '@/components/ds/input';
import { cn } from '@/lib/utils';
import { LegalFooter } from '@/components/legal/legal-footer';
import { safeNextPath } from '@/lib/auth/session-redirect';
import { inviteTokenOf } from '@/lib/auth/invite-token-of';
import { isImeComposing } from '@/lib/ime-composition';
import { useAdoptPrehydrationValues } from '@/hooks/use-adopt-prehydration-values';
import { useSubmitLatch } from '@/hooks/use-submit-latch';

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

/** story 5023 — the command a person types ON THE SERVER to see the setup code: drawn in code type UNDER the hint, outside the translated words (a Korean value holds no English word) */
const SERVER_STATUS_COMMAND = 'sprintable-host server status';

export default function RegisterPage() {
  const t = useTranslations('register');
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextParam = searchParams.get('next');
  // story 5023 — a workspace server whose sign-up is closed lets an invited e-mail in: the invitation's token rides on the sign-up request. It is read from the invitation link's own address
  // (`next` = /invite/accept?token=…, the journey of story 3220) — the same place the accept page reads it.
  const inviteToken = useMemo(() => inviteTokenOf(nextParam), [nextParam]);
  // story 5023 — a workspace server with NO owner yet asks the first account for its setup code. The field is not shown to everybody: it appears when the server says so (SETUP_CODE_REQUIRED), or at once when the
  // address says `?setup=1` (what the install notes link to).
  const [needsSetupCode, setNeedsSetupCode] = useState(searchParams.get('setup') === '1');
  const [setupCode, setSetupCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [tosAccepted, setTosAccepted] = useState(false);
  // story 4937 — what was typed / ticked before the screen came alive is taken into the state once, right after it does
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const tosRef = useRef<HTMLInputElement>(null);
  useAdoptPrehydrationValues(
    [{ ref: nameRef, initial: '', set: setDisplayName }, { ref: emailRef, initial: '', set: setEmail }, { ref: passwordRef, initial: '', set: setPassword, onAdopted: () => setPasswordTouched(true) }],
    [{ ref: tosRef, initial: false, set: setTosAccepted }],
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const latch = useSubmitLatch(setLoading); // story 4940 — one press = one request · a success stays locked until the next screen is there
  const submitReasonId = useId();
  const consentIds = { prefix: useId(), terms: useId(), and: useId(), privacy: useId() }; // the box is named by the WHOLE sentence: the words beside it and the two documents' names
  // story 4669 (U6 · Yuna A-5): with Google on, Google leads — the way with no mail round trip (email-verify-gate treats a social sign-in as verified).
  // story 4891 (UI-8 U1 · PO 11-10): the e-mail form is NOT folded behind a second press any more — one screen: the terms line, Google, the three fields, [가입]. The terms
  // checkbox (unticked by default, AUTH-07) still gates BOTH ways: Google goes nowhere until it is ticked and [가입] stays off; the server still refuses `tos_accepted=false`.
  const googleEnabled = process.env.NEXT_PUBLIC_OAUTH_ENABLED === 'true';

  // story 4960 (the 4959 lap · PO rule 11-13: a block says WHY, in place): while [가입] is off for a reason the person can fix, the reason is one line under it — the empty field first, then the terms (the same sentence the Google press says)
  // (a screen nothing has been put into yet says nothing: an empty form needs no line to be read as «fill me» — and the first screen keeps its room on a phone)
  // — and once something was put in it stays on (filling then clearing, or ticking then unticking, leaves the button off and the reason up)
  const startedFilling = [displayName, password].some((v) => v !== '') || email.length > 0 || tosAccepted;
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (startedFilling) setTouched(true); }, [startedFilling]);
  // the Google press already says the terms sentence in the banner above: the same words are not drawn twice
  const submitReason = !(touched || startedFilling) ? null : !displayName.trim() || !email.trim() || !password.trim() ? t('fieldsRequiredHint') : !tosAccepted && error !== t('tosRequiredError') ? t('tosRequiredError') : needsSetupCode && !setupCode.trim() && error !== t('registerSetupCodeRequired') ? t('registerSetupCodeRequired') : null;

  const rules = checkPasswordRules(password);
  const categoriesMet = countCategories(rules);
  const isPasswordValid = rules.length && categoriesMet >= 3;

  const handleRegister = async () => {
    if (!displayName.trim() || !email.trim() || !password.trim()) return;
    if (!tosAccepted) return;
    if (!isPasswordValid) {
      setPasswordTouched(true);
      return;
    }
    if (!latch.enter()) return;
    setError(null);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(), password, display_name: displayName.trim(), tos_accepted: true,
          ...(inviteToken ? { invite_token: inviteToken } : {}),
          ...(needsSetupCode && setupCode.trim() ? { setup_code: setupCode.trim() } : {}),
        }),
      });
      const json = await res.json() as { data?: { ok: boolean }; error?: { code?: string; message: string } };
      if (!res.ok || !json.data?.ok) {
        // story #2484 — code로 분기(backend auth.py register()가 _err()로 직접 발급하는
        // 안정 값). 알려지지 않은 code(pydantic 422 등)만 안전 폴백.
        if (json.error?.code === 'EMAIL_TAKEN') {
          setError(t('registerEmailTaken'));
        } else if (json.error?.code === 'TOS_NOT_ACCEPTED') {
          setError(t('registerTosRequired'));
        } else if (json.error?.code === 'SETUP_CODE_REQUIRED') {
          // story 5023 — a server with no owner yet: the field appears (and stays); the words say whether a code was missing or was not right
          setNeedsSetupCode(true);
          setError(setupCode.trim() ? t('registerSetupCodeWrong') : t('registerSetupCodeRequired'));
        } else if (json.error?.code === 'SIGNUP_CLOSED') {
          setError(t('registerSignupClosed')); // story 5023 — a server with an owner: only an invitation opens it
        } else {
          setError(t('registrationFailed'));
        }
        return;
      }
      const meRes = await fetch('/api/me');
      const meJson = await meRes.json() as { data?: { org_id?: string } };
      // story #3204 — sign_up 전환 이벤트 발화 신호(google-analytics.tsx의 route-change
      // effect가 소비). OAuth 경로(api/auth/callback/[provider]/route.ts)와 동일 파라미터로
      // 통일해 발화 지점을 하나로 모은다(SSOT).
      //
      // story #3220 — 비로그인 초대수락→가입 여정에서 여기가 org_id 유무만 보고 무조건
      // /inbox·/onboarding으로 밀어내 accept 복귀가 끊겼다(초대받은 사람이 자기 조직을
      // 만들게 됨). next가 있으면(오픈 리다이렉트 가드 safeNextPath 통과분만) 그쪽을
      // 최우선으로 — invite_accept.py 주석(story #3217)이 문서화한 의도된 여정
      // (login→가입→authenticated accept)과 일치. 목적지가 이미 자체 쿼리스트링을 갖고
      // 있을 수 있어(예: /invite/accept?token=…) `?signup=1` 고정 대신 구분자를 판별한다.
      const destination = nextParam ? safeNextPath(nextParam) : (meJson.data?.org_id ? '/inbox' : '/onboarding');
      const separator = destination.includes('?') ? '&' : '?';
      latch.hold(); // the push does not wait for the screen: the button stays «계정 만드는 중…» until the page is left (story 4940)
      router.push(`${destination}${separator}signup=1`);
      router.refresh();
    } catch {
      latch.unhold(); // the navigation itself threw after hold(): let go at once, the reason is on screen
      setError(t('registrationFailed'));
    } finally {
      latch.exit();
    }
  };

  const showRules = passwordTouched && password.length > 0;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ds-background px-4 py-4 sm:gap-8 sm:py-8">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-ds-line bg-ds-surface p-4 shadow-lg sm:space-y-6 sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SprintableLogo
            variant="stacked"
            className="text-foreground"
            markClassName="h-14"
            wordmarkClassName="h-5"
          />
          <p className="text-ds-body text-ds-ink-3">{t('subtitle')}</p>
        </div>

        {/* story 4669: the terms line first (both ways need it), then Google as the main button; story 4891: then the e-mail form, on the same screen */}
        {/* story 4891 (PO 11-11 · a person's first step on a phone): the box and its words are ONE ≥44 press (the label — a tap on the box or on «다음에 동의해요:» ticks it), and the two documents are their OWN named ≥44 links beside it, never inside the label — before, the middle of the sentence
            was a link, so a tap on the words opened the terms instead of ticking the box (dev walk 11-11). One checkbox still (AUTH-07: unticked by default, gates both ways). */}
        <div data-testid="register-consent" className="flex flex-wrap items-center gap-x-1.5 text-ds-small text-ds-ink-3">
          {/* the box and the words beside it are ONE press (the ds Checkbox is its own label, ≥ 44 on touch); the box is named by the WHOLE sentence (the two documents are links beside the label, not inside it — a screen reader must still hear what is agreed to) */}
          <Checkbox
            inputRef={tosRef}
            checked={tosAccepted}
            onCheckedChange={(checked) => setTosAccepted(checked === true)}
            disabled={loading}
            aria-labelledby={`${consentIds.prefix} ${consentIds.terms} ${consentIds.and} ${consentIds.privacy}`}
            label={<span id={consentIds.prefix}>{t('tosPrefix')}</span>}
            className="pr-1 text-ds-small text-ds-ink-3"
          />
          <Link id={consentIds.terms} href="/terms" target="_blank" className="inline-flex min-h-11 min-w-11 items-center justify-center font-medium text-brand-text hover:text-brand-text/85">
            {t('termsOfService')}
          </Link>
          <span id={consentIds.and}>{t('and')}</span>
          <Link id={consentIds.privacy} href="/privacy" target="_blank" className="inline-flex min-h-11 min-w-11 items-center justify-center font-medium text-brand-text hover:text-brand-text/85">
            {t('privacyPolicy')}
          </Link>
        </div>

        {/* story #2105 1차 — #2096과 같은 결함클래스(계정 없는 사람이 처음 만나는 화면인데
            실패 사유가 스크린리더에 안 읽힘). setError(null)이 재시도마다 먼저 실행돼(위
            handleRegister) 이 단락이 매번 언마운트→리마운트되므로 동일 사유가 반복돼도
            안정적으로 낭독된다. */}
        {error && <Banner tone="failed">{error}</Banner>}

        {googleEnabled && (
          <div className="space-y-3">
            {/* story #3220 — login/page.tsx의 OAuth 버튼들과 동일 패턴으로 next 전파
                (/auth/login/route.ts가 이미 next를 읽어 콜백까지 이어준다 — 이 버튼만
                빠져 있었음, fix-on-sight). story 4669: the main button, first (brand surface = the one hero on this screen) */}
            <a
              href={tosAccepted ? `/auth/login?provider=google&tos_accepted=true${nextParam ? `&next=${encodeURIComponent(nextParam)}` : ''}` : undefined}
              onClick={!tosAccepted ? (e) => { e.preventDefault(); setError(t('tosRequiredError')); } : undefined}
              // without an href an anchor is not reachable by keyboard — until the terms are ticked it is a focusable, announced-as-unavailable link that says why (Enter / Space, like a press)
              {...(!tosAccepted ? { role: 'link', tabIndex: 0, 'aria-disabled': true, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setError(t('tosRequiredError')); } } } : {})}
              data-testid="register-google"
              // the ds primary look; until the terms are ticked the link is «unavailable» in look (aria-disabled → dashed) but STILL takes the press — it is the press that says why (pointer events back on)
              className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full gap-3 aria-disabled:pointer-events-auto', !tosAccepted && 'cursor-not-allowed')}
            >
              <svg className="h-5 w-5 rounded-full bg-background p-0.5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              {t('continueWithGoogle')}
            </a>

            <div className="relative flex items-center">
              <div className="flex-grow border-t border-ds-line" />
              <span className="mx-3 flex-shrink text-ds-small text-ds-ink-3">{t('or')}</span>
              <div className="flex-grow border-t border-ds-line" />
            </div>

          </div>
        )}

        <div className="space-y-3" data-testid="register-email-form">
          {needsSetupCode && (
            <div className="space-y-1" data-testid="register-setup-code">
              <Input
                type="text"
                placeholder={t('setupCodePlaceholder')}
                aria-label={t('setupCodePlaceholder')}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value)}
                disabled={loading}
              />
              <p className="text-ds-small text-ds-ink-3">{t('setupCodeHint')}</p>
              <code className="block break-all rounded border border-ds-line bg-ds-surface px-2 py-1 font-mono text-ds-small text-ds-ink-2" data-testid="register-setup-command">{SERVER_STATUS_COMMAND}</code>
            </div>
          )}
          <Input
            type="text"
            placeholder={t('namePlaceholder')}
            aria-label={t('namePlaceholder')}
            autoComplete="name"
            ref={nameRef}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            onKeyDown={(e) => {
              // 한글 등 입력기 조합 중의 엔터는 «글자 확정 키»다 — 가입 제출로 읽으면 반쯤 쓴 이름(예: «홍길ㄷ»)으로 가입 요청이 나간다(4831 측정 중 발견).
              if (isImeComposing(e)) return;
              if (e.key === 'Enter') handleRegister();
            }}
            disabled={loading}
          />
          <Input
            type="email"
            placeholder={t('emailPlaceholder')}
            aria-label={t('emailPlaceholder')}
            autoComplete="email"
            ref={emailRef}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
            disabled={loading}
          />
          <Input
            type="password"
            placeholder={t('passwordPlaceholder')}
            aria-label={t('passwordPlaceholder')}
            autoComplete="new-password"
            aria-invalid={showRules && !isPasswordValid ? true : undefined}
            ref={passwordRef}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setPasswordTouched(true); }}
            onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
            disabled={loading}
          />
          {showRules && (
            <ul className="space-y-1 text-ds-small">
              <RuleItem met={rules.length} label={t('ruleLength')} />
              <li className={`flex items-center gap-1.5 ${categoriesMet >= 3 ? 'text-ds-done' : 'text-ds-ink-3'}`}>
                <span>{categoriesMet >= 3 ? '✓' : '○'}</span>
                <span>{t('ruleCategories', { count: categoriesMet })}</span>
              </li>
            </ul>
          )}
          {/* story 4669: with Google on this is the second way — not a second brand-colored button (the hero is Google's) */}
          <Button
            type="button"
            variant={googleEnabled ? 'secondary' : 'primary'}
            size="lg"
            className="w-full"
            onClick={handleRegister}
            disabled={loading || !displayName.trim() || !email.trim() || !password.trim() || !tosAccepted || (needsSetupCode && !setupCode.trim())}
            aria-describedby={submitReason ? submitReasonId : undefined}
            data-testid="register-submit"
          >
            {loading ? t('creatingAccount') : t('submit')}
          </Button>
          {submitReason && <p id={submitReasonId} role="status" data-testid="register-submit-reason" className="text-center text-ds-small text-ds-ink-3">{submitReason}</p>}
        </div>

        <p className="flex flex-wrap items-center justify-center gap-x-1 text-center text-ds-body text-ds-ink-3">
          <span>{t('alreadyHaveAccount')}</span>
          <Link href="/login" className="inline-flex min-h-11 min-w-11 items-center justify-center font-medium text-brand-text hover:text-brand-text/85">
            {t('signIn')}
          </Link>
        </p>
      </div>
      <LegalFooter />
    </div>
  );
}

function RuleItem({ met, label }: { met: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 ${met ? 'text-ds-done' : 'text-ds-ink-3'}`}>
      <span>{met ? '✓' : '○'}</span>
      <span>{label}</span>
    </li>
  );
}
