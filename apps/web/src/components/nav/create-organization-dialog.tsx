'use client';

import { useState } from 'react';
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
}

export function CreateOrganizationDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateOrganizationDialogProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [planLimitHit, setPlanLimitHit] = useState(false);
  // story #2154 — handleSubmit이 재시도 전 setPlanLimitHit(false)를 리셋하지 않아(setError만
  // 리셋), 같은 402 사유로 재시도해도 값이 계속 true라 재낭독이 안 될 수 있던 것을 nonce-key로
  // 구조적으로 막는다.
  const [planLimitNonce, bumpPlanLimitNonce] = useRenderNonce();

  const slugError = slug && !SLUG_REGEX.test(slug)
    ? '영소문자, 숫자, 하이픈만 사용 가능합니다 (시작/끝은 영소문자 또는 숫자)'
    : '';

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) {
      setSlug(toSlug(value));
    }
  }

  function handleSlugChange(value: string) {
    setSlugTouched(true);
    setSlug(value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
  }

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      setName('');
      setSlug('');
      setSlugTouched(false);
      setError('');
      setPlanLimitHit(false);
    }
    onOpenChange(nextOpen);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !slug.trim() || slugError || creating) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), slug: slug.trim() }),
      });
      const json = await res.json() as { data?: { id: string; name: string; slug: string }; error?: { message?: string }; detail?: { code?: string; message?: string } | string };
      if (!res.ok) {
        const detail = typeof json.detail === 'object' ? json.detail : null;
        if (res.status === 402 && detail?.code === 'PLAN_LIMIT_EXCEEDED') {
          bumpPlanLimitNonce();
          setPlanLimitHit(true);
          return;
        }
        setError(json.error?.message ?? (typeof json.detail === 'string' ? json.detail : null) ?? 'Organization 생성에 실패했습니다.');
        return;
      }
      if (!json.data) {
        setError('Organization 생성에 실패했습니다.');
        return;
      }
      handleClose(false);
      onCreated(json.data.id);
    } finally {
      setCreating(false);
    }
  }

  const canSubmit = name.trim().length > 0 && slug.trim().length > 0 && !slugError && !creating;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>새 Organization 만들기</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {planLimitHit && (
            <div key={planLimitNonce} role="alert" aria-live="assertive" aria-atomic="true" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm space-y-1">
              <p className="font-medium text-amber-800">Free 플랜 Organization 한도 초과</p>
              <p className="text-amber-700">Free 플랜은 Organization 1개까지만 생성할 수 있습니다.</p>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- story a539c649 S2 오탐, invite-accept-client.tsx 주석 참고 */}
              <a
                href="/settings?tab=billing"
                className="inline-block mt-1 text-xs font-medium text-amber-800 underline underline-offset-2 hover:text-amber-900"
              >
                Team 또는 Pro로 업그레이드하기 →
              </a>
            </div>
          )}
          {error && (
            // story #2105 2차 — handleSubmit이 재시도 전 setError('')를 먼저 호출해(위 정의) 매
            // 시도마다 언마운트→리마운트된다.
            <div role="alert" aria-live="assertive" aria-atomic="true" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="org-name">
              이름 <span className="text-destructive">*</span>
            </label>
            <input
              id="org-name"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="예: My Company"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="org-slug">
              Slug <span className="text-destructive">*</span>
            </label>
            <input
              id="org-slug"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="my-company"
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              required
            />
            {slugError ? (
              <p className="text-xs text-destructive">{slugError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                sprintable.app/{slug || '...'}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" disabled={creating}>취소</Button>} />
            <Button type="submit" disabled={!canSubmit}>
              {creating ? '생성 중…' : '만들기'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
