'use client';

import { useEffect, useState } from 'react';
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
  const [loading, setLoading] = useState(true);
  const [affected, setAffected] = useState<AffectedProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch(`/api/org-members/${member.id}/affected-projects`)
      .then(async (res) => {
        if (!res.ok) throw new Error('failed');
        const json = await res.json() as { data?: AffectedProject[] };
        setAffected(json.data ?? []);
      })
      .catch(() => setError('영향 프로젝트 목록을 불러오지 못했습니다. 다시 시도하세요.'))
      .finally(() => setLoading(false));
  }, [open, member.id]);

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
          <DialogTitle>멤버 제거</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{member.name}</span>
            {member.email ? <span className="text-muted-foreground"> ({member.email})</span> : null}
            <span> 을(를) 조직에서 제거합니다.</span>
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
                이 사용자는 아래 프로젝트에서도 함께 제거됩니다:
              </AlertDescription>
            </Alert>
            <div className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2">
              {affected.map((p) => (
                <div key={p.project_id} className="flex items-center justify-between gap-3 py-1 text-sm">
                  <span className="truncate text-foreground">{p.project_name}</span>
                  <Badge variant="outline" className="capitalize">{p.role}</Badge>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">이 작업은 되돌릴 수 없습니다.</p>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">이 사용자는 어느 프로젝트에도 참여하지 않습니다.</p>
            <p className="text-xs text-muted-foreground">이 작업은 되돌릴 수 없습니다.</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={confirming}>
            취소
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={loading || !!error || confirming}
          >
            {confirming ? '...' : '제거'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
