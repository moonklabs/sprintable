'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ds/dialog';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { Tag } from './settings-parts';
import { fetchWithAuth } from '@/lib/db/client';
import { pickEulReulJosa } from '@/lib/korean-particle';
import { resolveRoleLabel } from '@/app/(authenticated)/organization/trust/trust-utils';

interface AffectedProject {
  project_id: string;
  project_name: string;
  role: string;
}

export interface RemoveOrgMemberDialogProps {
  open: boolean;
  member: { id: string; name: string; email?: string };
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export function RemoveOrgMemberDialog({
  open,
  member,
  onConfirm,
  onCancel,
}: RemoveOrgMemberDialogProps) {
  const to = useTranslations('organization');
  // story #3776(1층B) — "취소"/"제거", common/settings ns의 기존 cancel/removeFromProject 키 재사용.
  const tc = useTranslations('common');
  const ts = useTranslations('settings');
  const [loading, setLoading] = useState(true);
  const [affected, setAffected] = useState<AffectedProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetchWithAuth(`/api/org-members/${member.id}/affected-projects`)
      .then(async (res) => {
        if (!res.ok) throw new Error('failed');
        const json = await res.json() as { data?: AffectedProject[] };
        setAffected(json.data ?? []);
      })
      .catch(() => setError(ts('affectedProjectsLoadFailed')))
      .finally(() => setLoading(false));
  }, [open, member.id, ts]);

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-md" initialFocus={cancelRef} aria-labelledby={titleId}>
        <DialogHeader>
          <DialogTitle id={titleId}>{ts('removeMemberTitle')}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-ds-ink">{member.name}</span>
            {member.email ? <span className="text-ds-ink-3"> ({member.email})</span> : null}
            {/* story #4120 — 조사는 이름 뒤에 공백 없이 바로 붙는다(한글 맞춤법). 이전엔
                고정 "을/를" 병기 앞에 literal 공백까지 있어 "{name} 을/를 조직에서"로
                이중으로 샜다 — 조사 선택과 함께 그 공백도 뗀다. */}
            <span>{ts('removeMemberConfirmSuffix', { josa: pickEulReulJosa(member.name) })}</span>
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <SkeletonGroup label={tc('loading')} className="space-y-2">
            <Skeleton variant="text" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </SkeletonGroup>
        ) : error ? (
          <Banner tone="failed">{error}</Banner>
        ) : affected && affected.length > 0 ? (
          <div className="space-y-3">
            <Banner tone="note">{ts('affectedProjectsWillBeRemoved')}</Banner>
            <div className="space-y-1 rounded-ds-control border border-ds-line bg-ds-surface-sunk px-3 py-2">
              {affected.map((p) => (
                <div key={p.project_id} className="flex items-center justify-between gap-3 py-1 text-ds-body">
                  <span className="min-w-0 truncate text-ds-ink">{p.project_name}</span>
                  <Tag>{resolveRoleLabel(p.role, null, to)}</Tag>
                </div>
              ))}
            </div>
            <p className="text-ds-small text-ds-ink-3">{ts('removeMemberIrreversible')}</p>
          </div>
        ) : (
          <div className="space-y-2 text-ds-body">
            <p className="text-ds-ink-3">{ts('memberNotInAnyProject')}</p>
            <p className="text-ds-small text-ds-ink-3">{ts('removeMemberIrreversible')}</p>
          </div>
        )}

        <DialogFooter>
          <Button ref={cancelRef} variant="quiet" onClick={onCancel} disabled={confirming}>
            {tc('cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void handleConfirm()}
            disabled={loading || !!error || confirming}
          >
            {confirming ? '...' : ts('removeFromProject')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
