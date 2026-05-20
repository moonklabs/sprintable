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
  onCreated: (org: { id: string; name: string; slug: string }) => void;
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
      const json = await res.json() as { data?: { id: string; name: string; slug: string }; error?: { message?: string } };
      if (!res.ok) {
        setError(json.error?.message ?? 'Organization 생성에 실패했습니다.');
        return;
      }
      if (!json.data) {
        setError('Organization 생성에 실패했습니다.');
        return;
      }
      handleClose(false);
      onCreated(json.data);
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
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
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
