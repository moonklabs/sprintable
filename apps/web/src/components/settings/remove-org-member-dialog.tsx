'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/db/client';
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{ts('removeMemberTitle')}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{member.name}</span>
            {member.email ? <span className="text-muted-foreground"> ({member.email})</span> : null}
            <span> {ts('removeMemberConfirmSuffix')}</span>
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2">
            <div className="h-4 animate-pulse rounded bg-muted" />
            <div className="h-12 animate-pulse rounded bg-muted" />
            <div className="h-12 animate-pulse rounded bg-muted" />
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : affected && affected.length > 0 ? (
          <div className="space-y-3">
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {ts('affectedProjectsWillBeRemoved')}
              </AlertDescription>
            </Alert>
            <div className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2">
              {affected.map((p) => (
                <div key={p.project_id} className="flex items-center justify-between gap-3 py-1 text-sm">
                  <span className="truncate text-foreground">{p.project_name}</span>
                  <Badge variant="outline">{resolveRoleLabel(p.role, null, to)}</Badge>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{ts('removeMemberIrreversible')}</p>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">{ts('memberNotInAnyProject')}</p>
            <p className="text-xs text-muted-foreground">{ts('removeMemberIrreversible')}</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={confirming}>
            {tc('cancel')}
          </Button>
          <Button
            variant="destructive"
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
