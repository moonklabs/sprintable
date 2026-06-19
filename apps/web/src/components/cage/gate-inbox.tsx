'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GateEvidence, gateNeedsAction, gateDecision } from '@/components/cage/gate-evidence';
import { GateLineContext } from '@/components/cage/gate-line-context';
import type { GateItem, WorkflowLineStatus, WorkflowLineStepRun } from '@/components/kanban/types';

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
  const [rejectedGates, setRejectedGates] = useState<GateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [rejectModal, setRejectModal] = useState<RejectModalState | null>(null);
  // S11 ②: 라인 컨텍스트(active step_run by story_id) + approver 이름맵.
  const [lineMap, setLineMap] = useState<Record<string, WorkflowLineStepRun>>({});
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});

  const fetchGates = async () => {
    try {
      const [pending, rejected] = await Promise.all([
        fetch('/api/gates?status=pending').then((r) => r.ok ? r.json() : []),
        fetch('/api/gates?status=rejected').then((r) => r.ok ? r.json() : []),
      ]);
      const pendingGates = pending as GateItem[];
      setGates(pendingGates);
      setRejectedGates((rejected as GateItem[]).filter((g) => g.resolution_note));

      // S11 ②: pending story 게이트별 workflow-line/status(bounded N=대기 게이트 수·N+1 아님) + 멤버 이름맵.
      const storyGates = pendingGates.filter((g) => g.work_item_type === 'story');
      if (storyGates.length > 0) {
        const [lineResults, membersJson] = await Promise.all([
          Promise.all(
            storyGates.map((g) =>
              fetch(`/api/stories/${g.work_item_id}/workflow-line/status`)
                .then((r) => (r.ok ? (r.json() as Promise<WorkflowLineStatus>) : null))
                .catch(() => null),
            ),
          ),
          fetch('/api/team-members')
            .then((r) => (r.ok ? r.json() : { data: [] }))
            .catch(() => ({ data: [] })),
        ]);
        const lmap: Record<string, WorkflowLineStepRun> = {};
        for (const ls of lineResults) {
          if (ls?.has_active && ls.active) lmap[ls.story_id] = ls.active;
        }
        setLineMap(lmap);
        const names: Record<string, string> = {};
        for (const m of (membersJson as { data?: { id: string; name: string }[] }).data ?? []) {
          names[m.id] = m.name;
        }
        setMemberNames(names);
      }
    } catch {
      // non-critical — 라인 컨텍스트 없으면 게이트 행은 기존대로 렌더.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchGates(); }, []);

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
        body: JSON.stringify({ status: 'rejected', resolver_id: memberId, note: rejectModal.note || null }),
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
          <div key={gate.id} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-xs font-medium text-foreground">{gate.gate_type}</span>
                <span className="truncate text-xs text-muted-foreground">#{gate.work_item_id.slice(0, 6)}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground/70">{new Date(gate.created_at).toLocaleDateString()}</span>
              </div>
              {/* S11 ②: 라인 컨텍스트("어디·누가·언제") + ④ 구분선 → H1 GateEvidence("왜")와 분리 */}
              {lineMap[gate.work_item_id] ? (
                <>
                  <GateLineContext
                    step={lineMap[gate.work_item_id]!}
                    resolveName={(id) => memberNames[id] ?? id.slice(0, 6)}
                    className="mt-1"
                  />
                  <div className="flex items-center gap-2 pt-1.5">
                    <span className="shrink-0 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
                      {t('lineEvidenceDivider')}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                </>
              ) : null}
              {/* H1-S8: decision 배지 + CI/신뢰도 facts + 사유(read-only evidence) */}
              <GateEvidence gate={gate} className="mt-1" />
            </div>
            {/* 액션 = requires_human 기준(block 제외·읽기전용·AC⑤). 미충족 게이트는 표시만. */}
            {gateNeedsAction(gate) ? (
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
            ) : (
              <span className="shrink-0 self-center text-[11px] text-muted-foreground">
                {gateDecision(gate) === 'block' ? t('gateReadonlyBlock') : t('gateReadonlyAuto')}
              </span>
            )}
          </div>
        ))
      )}

      {/* 반려 사유 히스토리 */}
      {rejectedGates.length > 0 && (
        <div className="mt-4 space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">{t('gateRejectedHistory')}</p>
          {rejectedGates.map((gate) => (
            <div key={gate.id} className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2">
              <div className="flex items-center gap-2">
                <XCircle className="size-3 shrink-0 text-destructive/60" />
                <span className="text-[10px] text-muted-foreground">{gate.gate_type} · #{gate.work_item_id.slice(0, 6)}</span>
              </div>
              <p className="mt-1 text-xs text-foreground/80">{gate.resolution_note}</p>
            </div>
          ))}
        </div>
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
