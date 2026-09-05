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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { fetchWithAuth } from '@/lib/db/client';
import { getEntityHref } from '@/components/chat/embed-card';
import { parseInsightsBoardApiError } from './insights-board-error';
import type { FollowUpCreateResponse, FollowUpKind } from './types';

/**
 * story #3503 — hypothesis-resolve-dialog.tsx의 다이얼로그 골격(Dialog>DialogContent
 * max-h-[85vh] flex flex-col sm:max-w-lg > form > DialogFooter, 상호배타 로컬 useState)을
 * 3지선다(republish/edit/stop)로 변형. 성공 시 전체 페이지 리다이렉트가 아니라 다이얼로그
 * 안에 성공 문구+링크를 보여준다(PO 브리프 — content/[draftId]/page.tsx의 인라인 <a> 성공
 * 링크 패턴 재사용, getEntityHref('story', story_id)로 목적지 조립 — 새 /stories/[id]
 * 페이지를 만들지 않는다).
 */
export interface FollowUpDialogProps {
  orgId: string;
  publicationId: string;
  onClose: () => void;
}

const KIND_OPTIONS: FollowUpKind[] = ['republish', 'edit', 'stop'];

export function FollowUpDialog({ orgId, publicationId, onClose }: FollowUpDialogProps) {
  const t = useTranslations('insightsBoard');
  const [kind, setKind] = useState<FollowUpKind>('republish');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successStoryId, setSuccessStoryId] = useState<string | null>(null);

  const kindLabel: Record<FollowUpKind, string> = {
    republish: t('followUpKindRepublish'),
    edit: t('followUpKindEdit'),
    stop: t('followUpKindStop'),
  };

  async function handleSubmit() {
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/publications/${publicationId}/follow-ups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          title: title.trim() || null,
          note: note.trim() || null,
        }),
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: FollowUpCreateResponse } | null;
        const storyId = json?.data?.story_id;
        if (storyId) {
          setSuccessStoryId(storyId);
        } else {
          setErrorMessage(t('followUpErrorGeneric'));
        }
        return;
      }
      const body = (await res.json().catch(() => null)) as { detail?: unknown; error?: Record<string, unknown> } | null;
      const info = parseInsightsBoardApiError(body);
      setErrorMessage(info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('followUpErrorGeneric')));
    } catch {
      setErrorMessage(t('followUpErrorGeneric'));
    } finally {
      setSubmitting(false);
    }
  }

  const storyHref = successStoryId ? getEntityHref('story', successStoryId) : null;

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t('followUpDialogTitle')}</DialogTitle>
        </DialogHeader>

        {successStoryId ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <Alert variant="success" role="status" aria-live="polite" aria-atomic="true">
              <AlertDescription>
                {t('followUpSuccessMessage')}
                {storyHref ? (
                  <>
                    {' '}
                    <a href={storyHref} className="underline" data-testid="follow-up-success-link">
                      {t('followUpSuccessLink')}
                    </a>
                  </>
                ) : null}
              </AlertDescription>
            </Alert>
            <DialogFooter className="shrink-0">
              <DialogClose render={<Button type="button" variant="outline" onClick={onClose}>{t('followUpClose')}</Button>} />
            </DialogFooter>
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!submitting) void handleSubmit();
            }}
          >
            <div className="shrink-0 space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t('followUpKindLabel')}</p>
              <div className="flex gap-2">
                {KIND_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setKind(option)}
                    aria-pressed={kind === option}
                    className={`rounded-md border px-3 py-1.5 text-sm ${
                      kind === option
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    }`}
                    data-testid={`follow-up-kind-${option}`}
                  >
                    {kindLabel[option]}
                  </button>
                ))}
              </div>
            </div>

            <div className="shrink-0 space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="follow-up-title">
                {t('followUpTitleLabel')}
              </label>
              <input
                id="follow-up-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('followUpTitlePlaceholder')}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div className="shrink-0 space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="follow-up-note">
                {t('followUpNoteLabel')}
              </label>
              <textarea
                id="follow-up-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('followUpNotePlaceholder')}
                rows={3}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {errorMessage ? (
              <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
                <AlertDescription data-testid="follow-up-error">{errorMessage}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter className="shrink-0">
              <DialogClose render={<Button type="button" variant="ghost" disabled={submitting} onClick={onClose}>{t('followUpCancel')}</Button>} />
              <Button type="submit" disabled={submitting}>
                {submitting ? t('followUpSubmitting') : t('followUpSubmit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
