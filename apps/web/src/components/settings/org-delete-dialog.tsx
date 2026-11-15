'use client';

// story 4891 (UI-8 · settings frame + four tabs) — the confirmation of «조직 삭제» (opened from the organization pane's danger card), drawn with the ds Dialog. The page keeps the state and the request and decides whether the button may be pressed
// (`canSubmitOrgDelete`); this file only draws what it is given and hands the presses back.
//
// What the window says is unchanged (story #2092 · the impact the deletion would have, or — when it could not be read — a warning with a retry and an explicit «I understand» that the audit remembers; the name to type is the last gate):
// the impact counts, the unreadable-impact warning + «다시 시도» + the acknowledgement, the type-the-name field, «취소» and the red button.
import { useId, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Checkbox } from '@/components/ds/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ds/dialog';
import { Field } from '@/components/ds/field';
import { Input } from '@/components/ds/input';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';

export interface OrgImpact { project_count: number; member_count: number; has_active_subscription: boolean }

export interface OrgDeleteDialogProps {
  orgName: string;
  impact: OrgImpact | null;
  impactLoading: boolean;
  confirmName: string;
  onConfirmName: (value: string) => void;
  confirmWithoutImpact: boolean;
  onConfirmWithoutImpact: (value: boolean) => void;
  deleting: boolean;
  /** the page's `canSubmitOrgDelete(...)` */
  canSubmit: boolean;
  onRetryImpact: () => void;
  onClose: () => void;
  onConfirm: () => void;
}

export function OrgDeleteDialog(p: OrgDeleteDialogProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !p.deleting) p.onClose(); }}>
      <DialogContent className="max-w-md" showCloseButton={false} initialFocus={nameRef} aria-labelledby={titleId}>
        <DialogHeader>
          <DialogTitle id={titleId} className="text-ds-failed">{t('orgDeleteTitle')}</DialogTitle>
        </DialogHeader>

        {/* the impact */}
        {p.impactLoading ? (
          <SkeletonGroup label={tc('loading')} className="space-y-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-6" />)}
          </SkeletonGroup>
        ) : p.impact ? (
          <div className="flex flex-col gap-1 rounded-ds-control border border-ds-line bg-ds-surface-sunk px-3 py-2 text-ds-body">
            <p className="text-ds-ink-3">{t('orgDeleteImpactTitle')}</p>
            <ul className="space-y-0.5 text-ds-ink">
              <li>{t('orgDeleteImpactProjects', { count: p.impact.project_count })}</li>
              <li>{t('orgDeleteImpactMembers', { count: p.impact.member_count })}</li>
              {p.impact.has_active_subscription ? <li>{t('orgDeleteImpactSubscription')}</li> : null}
            </ul>
          </div>
        ) : (
          // story #2092(P0) — an impact that could not be read must not read as «no impact»: the button stays off until it is read, or the person says in so many words that they go on without it
          <div className="flex flex-col gap-3 rounded-ds-control border border-ds-line bg-ds-surface-high p-3">
            <Banner tone="note">{t('orgDeleteImpactUnavailable')}</Banner>
            <div>
              <Button type="button" variant="secondary" onClick={p.onRetryImpact} disabled={p.impactLoading}>
                {tc('retry')}
              </Button>
            </div>
            <Checkbox
              checked={p.confirmWithoutImpact}
              onCheckedChange={(checked) => p.onConfirmWithoutImpact(checked === true)}
              label={
                <span className="flex flex-col gap-0.5">
                  <span>{t('orgDeleteWithoutImpact')}</span>
                  <span className="text-ds-small text-ds-ink-3">{t('orgDeleteWithoutImpactAudit')}</span>
                </span>
              }
            />
          </div>
        )}

        <Field label={t('orgDeleteConfirmPrompt', { name: p.orgName })}>
          {(c) => <Input {...c} ref={nameRef} placeholder={p.orgName} value={p.confirmName} onChange={(e) => p.onConfirmName(e.target.value)} />}
        </Field>

        <DialogFooter>
          <Button variant="quiet" onClick={p.onClose} disabled={p.deleting}>
            {tc('cancel')}
          </Button>
          <Button variant="danger" onClick={p.onConfirm} disabled={!p.canSubmit}>
            {p.deleting ? tc('deleting') : t('orgDeleteConfirmCta')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
