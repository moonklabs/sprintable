'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { GateItem } from '@/components/kanban/types';

interface GateInboxProps {
  memberId: string;
}

interface RejectModalState {
  gateId: string;
  note: string;
}

export function GateInbox({ memberId }: GateInboxProps) {
  const t = useTranslations('cage');
  const [gates, setGates] = useState<GateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [rejectModal, setRejectModal] = useState<RejectModalState | null>(null);

  const fetchGates = () => {
    fetch('/api/gates?status=pending')
      .then((r) => r.ok ? r.json() : [])
      .then((json) => setGates(json as GateItem[]))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchGates(); }, []);

  const handleApprove = async (gateId: string) => {
    setResolving(gateId);
    try {
      const res = await fetch(`/api/gates/${gateId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved', resolver_id: memberId }),
      });
      if (res.ok) setGates((prev) => prev.filter((g) => g.id !== gateId));
    } finally {
      setResolving(null);
    }
  };

  const handleReject = async () => {
    if (!rejectModal) return;
    setResolving(rejectModal.gateId);
    try {
      const res = await fetch(`/api/gates/${rejectModal.gateId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rejected', resolver_id: memberId }),
      });
      if (res.ok) {
        setGates((prev) => prev.filter((g) => g.id !== rejectModal.gateId));
        setRejectModal(null);
      }
    } finally {
      setResolving(null);
    }
  };

  if (loading) return <p className="text-xs text-muted-foreground">{t('gateInboxLoading')}</p>;

  return (
    <div className="space-y-2">
      {gates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-5 text-center">
          <p className="text-sm text-muted-foreground">{t('gateInboxEmpty')}</p>
          <p className="mt-1 text-xs text-muted-foreground/60">{t('gateInboxEmptyHint')}</p>
        </div>
      ) : (
        gates.map((gate) => (
          <div key={gate.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <Badge variant="info" className="shrink-0">
                  <span className="mr-1">⏸</span>{gate.gate_type}
                </Badge>
                <span className="truncate text-xs text-muted-foreground">#{gate.work_item_id.slice(0, 6)}</span>
              </div>
              <p className="text-[10px] text-muted-foreground">{new Date(gate.created_at).toLocaleDateString()}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-success hover:bg-success-tint hover:text-success"
                disabled={resolving === gate.id}
                onClick={() => void handleApprove(gate.id)}
              >
                <CheckCircle className="size-3.5" />
                {t('gateApprove')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                disabled={resolving === gate.id}
                onClick={() => setRejectModal({ gateId: gate.id, note: '' })}
              >
                <XCircle className="size-3.5" />
                {t('gateReject')}
              </Button>
            </div>
          </div>
        ))
      )}

      {/* 반려 모달 */}
      {rejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
            onClick={() => setRejectModal(null)}
            aria-label={t('cancel')}
          />
          <div className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-xl">
            <h3 className="mb-3 text-sm font-semibold">{t('gateRejectTitle')}</h3>
            <textarea
              rows={3}
              value={rejectModal.note}
              onChange={(e) => setRejectModal((prev) => prev ? { ...prev, note: e.target.value } : null)}
              placeholder={t('gateRejectNotePlaceholder')}
              className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRejectModal(null)}>{t('cancel')}</Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={!!resolving}
                onClick={() => void handleReject()}
              >
                {resolving ? '...' : t('gateRejectConfirm')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
