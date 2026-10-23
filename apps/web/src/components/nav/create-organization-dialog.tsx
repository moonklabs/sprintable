'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useRenderNonce } from '@/hooks/use-render-nonce';
import { getPublicAppHost } from '@/lib/public-app-host';
import { useFlatHref } from '@/hooks/use-flat-href';
import { isEEEnabled } from '@/lib/ee';
import { limitCopy } from '@/lib/plan-limit-copy';

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$|^[a-z0-9]$/;

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

interface CreateOrganizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (orgId: string) => void;
  /** story 4721: the name the box opens with (the Mac app's setup card fills it the way the app path names an organization). */
  initialName?: string;
  /** story 4721: the address name may stay empty — the server derives it from the name (story 4669), as the first-screen path does. */
  slugOptional?: boolean;
  /** story 4721: the server wants the e-mail verified first (403 EMAIL_VERIFICATION_REQUIRED). Given, the dialog closes and hands over to this
   *  (the caller shows the e-mail gate); not given, it is the generic error line as before. */
  onEmailVerificationRequired?: () => void;
}

export function CreateOrganizationDialog({
  open,
  onOpenChange,
  onCreated,
  initialName = '',
  slugOptional = false,
  onEmailVerificationRequired,
}: CreateOrganizationDialogProps) {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('nav');
  // story #2470 후속(유나 홀름 design:changes) — 온보딩 wizard 경로(#2470 본체)는 완전
  // i18n인데 이 dialog의 한도 배너 본문은 별도로 하드코딩 영한혼용이었다("Free 플랜
  // Organization 한도 초과"). 같은 개념(무료 플랜 조직 한도)을 두 곳에서 따로 번역해 두면
  // 나중에 한쪽만 고쳐지는 갈림이 재발하므로, 온보딩과 같은 키(orgLimitExceededError)를
  // 재사용한다 — 문구가 실제로 하나의 출처를 갖는다.
  const tOnboarding = useTranslations('onboarding');
  const tc = useTranslations('common');
  // story 4721: where the address is optional it is only what the person typed — never derived from the name here (a Korean name gives «-»,
  // «Jiwoo의 조직» gives «jiwoo-»; and a derived address that collides would answer 409 where the server would have numbered it): the
  // server derives it (story 4669), as the first-screen path does
  const derive = (n: string) => (slugOptional ? '' : toSlug(n));
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(derive(initialName));
  const [slugTouched, setSlugTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [planLimitHit, setPlanLimitHit] = useState(false);
  // story #2154 — handleSubmit이 재시도 전 setPlanLimitHit(false)를 리셋하지 않아(setError만
  // 리셋), 같은 402 사유로 재시도해도 값이 계속 true라 재낭독이 안 될 수 있던 것을 nonce-key로
  // 구조적으로 막는다.
  const [planLimitNonce, bumpPlanLimitNonce] = useRenderNonce();

  const slugError = slug && !SLUG_REGEX.test(slug)
    ? t('createOrgSlugError')
    : '';

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) {
      setSlug(derive(value));
    }
  }

  function handleSlugChange(value: string) {
    setSlugTouched(true);
    setSlug(value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
  }

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      setName(initialName);
      setSlug(derive(initialName));
      setSlugTouched(false);
      setError('');
      setPlanLimitHit(false);
    }
    onOpenChange(nextOpen);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || (!slugOptional && !slug.trim()) || slugError || creating) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slug.trim() ? { name: name.trim(), slug: slug.trim() } : { name: name.trim() }),
      });
      const json = await res.json() as { data?: { id: string; name: string; slug: string }; error?: { code?: string; message?: string }; detail?: { code?: string; message?: string } | string };
      if (!res.ok) {
        // story #2470 — 실측(2026-08-06): 응답 envelope은 `{error:{code,...}}`다(BE
        // HTTPException(detail=...)이 exception handler를 거쳐 `error`로 재포장된다).
        // `json.detail`만 보던 이전 체크는 실제 응답에 그 필드가 없어 항상 죽은 분기였고
        // (한도 초과여도 이 브랜치를 못 타 raw 영문 message로 계속 폴백) — `error.code`를
        // 1순위로, `detail`은 하위호환 폴백으로 남긴다.
        const detail = typeof json.detail === 'object' ? json.detail : null;
        if (res.status === 402 && (json.error?.code === 'PLAN_LIMIT_EXCEEDED' || detail?.code === 'PLAN_LIMIT_EXCEEDED')) {
          bumpPlanLimitNonce();
          setPlanLimitHit(true);
          return;
        }
        // story #2484 — 잔여 폴백도 code로 분기(organizations.py create_organization()이
        // 낼 수 있는 나머지: 400 "Invalid slug format"/409 "Slug already exists", 둘 다
        // plain-string detail이라 제네릭 매핑됨). 알려지지 않은 code만 안전 폴백.
        const code = json.error?.code ?? detail?.code;
        if (res.status === 403 && code === 'EMAIL_VERIFICATION_REQUIRED' && onEmailVerificationRequired) {
          handleClose(false);
          onEmailVerificationRequired();
          return;
        }
        if (code === 'CONFLICT') {
          setError(t('createOrgSlugTaken'));
        } else if (code === 'BAD_REQUEST') {
          setError(t('createOrgSlugError'));
        } else {
          setError(t('createOrgGenericError'));
        }
        return;
      }
      if (!json.data) {
        setError(t('createOrgGenericError'));
        return;
      }
      handleClose(false);
      onCreated(json.data.id);
    } finally {
      setCreating(false);
    }
  }

  // story 4680 (Yuna §N-2): the same switch as the project and agent banners — billing closed (prod today) → the fact, no way
  const orgLimit = limitCopy({ resource: 'org', limit: 1, free: true, billingOpen: isEEEnabled() });
  const canSubmit = name.trim().length > 0 && (slugOptional || slug.trim().length > 0) && !slugError && !creating;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('switcherNewOrganization')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {planLimitHit && (
            <div key={planLimitNonce} role="alert" aria-live="assertive" aria-atomic="true" className="rounded-md border border-warning-border bg-warning-tint px-3 py-3 text-sm space-y-1">
              <p className="font-medium text-warning-strong break-keep">{t(orgLimit.title)}</p>
              {orgLimit.reason ? <p className="text-warning-strong break-keep">{tOnboarding(orgLimit.reason.key, orgLimit.reason.withLimit ? { limit: 1 } : undefined)}</p> : null}
              {orgLimit.link ? (
                <a
                  href={flatHref('/settings?tab=billing')}
                  className="inline-block mt-1 text-xs font-medium text-warning-strong underline underline-offset-2 transition hover:opacity-80"
                >
                  {t('orgLimitUpgradeLink')}
                </a>
              ) : null}
            </div>
          )}
          {error && (
            // story #2105 2차 — handleSubmit이 재시도 전 setError('')를 먼저 호출해(위 정의) 매
            // 시도마다 언마운트→리마운트된다.
            <div role="alert" aria-live="assertive" aria-atomic="true" className="rounded-md bg-destructive-tint px-3 py-2 text-sm text-foreground">
              {error}
            </div>
          )}
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="org-name">
              {t('createOrgNameLabel')} <span className="text-destructive">*</span>
            </label>
            <input
              id="org-name"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-base lg:text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder={t('createOrgNamePlaceholder')}
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="org-slug">
              {t('createOrgSlugLabel')}{slugOptional ? null : <> <span className="text-destructive">*</span></>}
            </label>
            <input
              id="org-slug"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-base lg:text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder={t('createOrgSlugPlaceholder')}
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              required={!slugOptional}
            />
            {slugError ? (
              <p className="text-xs text-destructive">{slugError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {getPublicAppHost()}/{slug || '...'}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" disabled={creating}>{tc('cancel')}</Button>} />
            <Button type="submit" disabled={!canSubmit}>
              {creating ? tc('creating') : t('switcherCreateButton')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
