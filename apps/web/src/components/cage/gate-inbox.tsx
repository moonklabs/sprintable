'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle, XCircle, Ban, MoreHorizontal, AlertTriangle, Pause, PlayCircle, UserCog, ArrowRightLeft, Gavel, Crown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { GateEvidence, gateNeedsAction, gateDecision, gateHasEvidence } from '@/components/cage/gate-evidence';
import { GateLineContext } from '@/components/cage/gate-line-context';
import { GateReassignModal } from '@/components/cage/gate-reassign-modal';
import { GateOverrideModal } from '@/components/cage/gate-override-modal';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem, GateApproverItem, WorkflowLineStatus, WorkflowLineStepRun } from '@/components/kanban/types';

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
  // S30: admin gate 무효화(void) — voided 히스토리 + 확인 모달. isAdmin은 dashboard role(BE도 admin 강제).
  const [voidedGates, setVoidedGates] = useState<GateItem[]>([]);
  const [voidModal, setVoidModal] = useState<{ gateId: string; reason: string } | null>(null);
  // S31 fix: held(status='held') gate는 pending 목록서 빠지므로 별도 fetch — 보류중 행+[재개] 렌더용.
  const [heldGates, setHeldGates] = useState<GateItem[]>([]);
  const { role, projectId } = useDashboardContext();
  const isAdmin = role === 'admin' || role === 'owner';
  const isOwner = role === 'owner'; // S33: override는 owner-only(admin 미포함·BE is_org_owner 강제)
  // S31: 보류(hold) — 모달(사유 선택·무기한/시한부 held_until). held=Pause(재개가능·pending 유지)↔void=Ban(종료).
  // held 판정은 status==='held' OR held_until(디디 BE 표현 미확정·둘 다 커버·머지 후 정합).
  const [holdModal, setHoldModal] = useState<{ gateId: string; reason: string; indefinite: boolean; heldUntil: string } | null>(null);
  const isHeld = (g: GateItem) => g.status === 'held' || !!g.held_until;
  const resolveName = (id: string) => memberNames[id] ?? id.slice(0, 6);
  // S11 ②: 라인 컨텍스트(active step_run by story_id) + approver 이름맵.
  const [lineMap, setLineMap] = useState<Record<string, WorkflowLineStepRun>>({});
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  // S32: parallel gate 결재자 재지정 — gate별 approver 목록(conditional-display·reassign 메타 enrich) + 재지정 모달.
  const [gateApproversMap, setGateApproversMap] = useState<Record<string, GateApproverItem[]>>({});
  const [reassignGateId, setReassignGateId] = useState<string | null>(null);
  // S33: owner 결재 강제(override) — 모달 대상 gate.
  const [overrideGateId, setOverrideGateId] = useState<string | null>(null);

  const fetchGates = async () => {
    try {
      // S31 fix: held(status='held')는 pending fetch서 빠지므로 별도 fetch — 안 하면 보류 gate가
      // GateInbox서 사라져 [재개] unreachable(라이브 픽셀 적출). status-batch 패턴에 held 추가.
      const [pending, rejected, voided, held] = await Promise.all([
        fetch('/api/gates?status=pending').then((r) => r.ok ? r.json() : []),
        fetch('/api/gates?status=rejected').then((r) => r.ok ? r.json() : []),
        fetch('/api/gates?status=voided').then((r) => r.ok ? r.json() : []),
        fetch('/api/gates?status=held').then((r) => r.ok ? r.json() : []),
      ]);
      const pendingGates = pending as GateItem[];
      setGates(pendingGates);
      setRejectedGates((rejected as GateItem[]).filter((g) => g.resolution_note));
      setVoidedGates(voided as GateItem[]);
      setHeldGates(held as GateItem[]);

      // S32: pending gate별 approver 목록(parallel gate만 rows·bounded N·conditional-display + reassign 메타 enrich).
      const approverResults = await Promise.all(
        pendingGates.map((g) =>
          fetch(`/api/gates/${g.id}/approvers`)
            .then((r) => (r.ok ? (r.json() as Promise<GateApproverItem[]>) : []))
            .catch(() => []),
        ),
      );
      const amap: Record<string, GateApproverItem[]> = {};
      pendingGates.forEach((g, i) => { const rows = approverResults[i]; if (rows && rows.length) amap[g.id] = rows; });
      setGateApproversMap(amap);

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

  const handleVoid = async () => {
    if (!voidModal || !voidModal.reason.trim() || resolving) return;
    setResolving(voidModal.gateId);
    try {
      const res = await fetch(`/api/gates/${voidModal.gateId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: voidModal.reason.trim() }),
      });
      if (res.ok) { setVoidModal(null); await fetchGates(); }
    } finally {
      setResolving(null);
    }
  };

  const handleHold = async () => {
    if (!holdModal || resolving) return;
    if (!holdModal.indefinite && !holdModal.heldUntil) return; // 시한부면 날짜 필수
    setResolving(holdModal.gateId);
    try {
      const body: { reason?: string; held_until: string | null } = {
        held_until: holdModal.indefinite ? null : holdModal.heldUntil,
      };
      if (holdModal.reason.trim()) body.reason = holdModal.reason.trim();
      const res = await fetch(`/api/gates/${holdModal.gateId}/hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) { setHoldModal(null); await fetchGates(); }
    } finally {
      setResolving(null);
    }
  };

  const handleUnhold = async (gateId: string) => {
    if (resolving) return;
    setResolving(gateId);
    try {
      const res = await fetch(`/api/gates/${gateId}/unhold`, { method: 'POST' });
      if (res.ok) await fetchGates();
    } finally {
      setResolving(null);
    }
  };

  if (loading) return <p className="text-xs text-muted-foreground">{t('gateInboxLoading')}</p>;

  // S31 fix: pending + held 합쳐 렌더 — held(status='held') 행이 ⏸"보류중"+[재개]로 남아야 unhold 도달가능(disjoint status·라이브 픽셀 적출 수정).
  const activeGates = [...gates, ...heldGates];

  return (
    <div className="space-y-2">
      {activeGates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-5 text-center">
          <p className="text-sm text-muted-foreground">{t('gateInboxEmpty')}</p>
          <p className="mt-1 text-xs text-muted-foreground/60">{t('gateInboxEmptyHint')}</p>
        </div>
      ) : (
        activeGates.map((gate) => (
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
                  {/* S3: 증거 없는 카드(State A)는 구분선도 숨김 — 빈 블록 위 헤더 방지(omit) */}
                  {gateHasEvidence(gate) ? (
                    <div className="flex items-center gap-2 pt-1.5">
                      <span className="shrink-0 text-[9px] font-medium text-muted-foreground/70">
                        {t('lineEvidenceDivider')}
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  ) : null}
                </>
              ) : null}
              {/* H1-S8: decision 배지 + CI/신뢰도 facts + 사유(read-only evidence) */}
              <GateEvidence gate={gate} className="mt-1" />
              {/* S32: parallel gate approver rows — 재지정 메타(이전 취소선→ArrowRightLeft→새·재지정됨·{admin}·{시각}) */}
              {(gateApproversMap[gate.id]?.length ?? 0) > 0 ? (
                <ul className="mt-1.5 space-y-0.5">
                  {gateApproversMap[gate.id]!.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      {a.reassigned_from_member_id ? (
                        <>
                          <span className="line-through">{resolveName(a.reassigned_from_member_id)}</span>
                          <ArrowRightLeft className="size-3 shrink-0" />
                        </>
                      ) : null}
                      <span className="text-foreground">{resolveName(a.approver_member_id)}</span>
                      {a.reassigned_by_member_id ? (
                        <span className="text-[10px] text-muted-foreground/70">
                          · {t('reassignedBy', { admin: resolveName(a.reassigned_by_member_id), at: a.reassigned_at ? new Date(a.reassigned_at).toLocaleDateString() : '' })}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {/* 액션 = requires_human 기준(block 제외·읽기전용·AC⑤). + S30 admin ⋯ 무효화(전 pending gate·admin only). */}
            <div className="flex shrink-0 items-center gap-1.5">
              {isHeld(gate) ? (
                <>
                  {/* S31 보류중: ⏸ Pause(중립 secondary·재개가능)·SLA 일시정지 */}
                  <Badge variant="secondary" className="gap-1" title={t('slaPaused')}>
                    <Pause className="size-3 shrink-0" />
                    {t('heldBadge')}
                  </Badge>
                  {gate.held_until ? (
                    <span className="text-[10px] text-muted-foreground">{t('heldUntilLabel', { date: new Date(gate.held_until).toLocaleDateString() })}</span>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 text-primary hover:bg-primary/10 hover:text-primary"
                    disabled={resolving === gate.id}
                    onClick={() => void handleUnhold(gate.id)}
                  >
                    <PlayCircle className="size-3.5" />
                    {t('resumeAction')}
                  </Button>
                </>
              ) : gateNeedsAction(gate) ? (
                <>
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
                </>
              ) : (
                <span className="self-center text-[11px] text-muted-foreground">
                  {gateDecision(gate) === 'block' ? t('gateReadonlyBlock') : t('gateReadonlyAuto')}
                </span>
              )}
              {isAdmin ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={t('gateMoreActions')}
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <MoreHorizontal className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {/* S32: 결재자 변경 — approver rows 있는 parallel gate만(conditional·보이는=실행가능·422 차단) */}
                    {!isHeld(gate) && (gateApproversMap[gate.id]?.length ?? 0) > 0 ? (
                      <DropdownMenuItem onClick={() => setReassignGateId(gate.id)}>
                        <UserCog className="mr-2 size-3.5" />
                        {t('reassignAction')}
                      </DropdownMenuItem>
                    ) : null}
                    {!isHeld(gate) ? (
                      <DropdownMenuItem onClick={() => setHoldModal({ gateId: gate.id, reason: '', indefinite: true, heldUntil: '' })}>
                        <Pause className="mr-2 size-3.5" />
                        {t('holdAction')}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => setVoidModal({ gateId: gate.id, reason: '' })}
                    >
                      <Ban className="mr-2 size-3.5" />
                      {t('voidAction')}
                    </DropdownMenuItem>
                    {/* S33: owner-only 결재 강제(override) — admin 항목과 구분선·admin엔 미노출 */}
                    {isOwner ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setOverrideGateId(gate.id)}
                        >
                          <Gavel className="mr-2 size-3.5" />
                          {t('overrideAction')}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        ))
      )}

      {/* 반려 사유 히스토리 */}
      {rejectedGates.length > 0 && (
        <div className="mt-4 space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">{t('gateRejectedHistory')}</p>
          {rejectedGates.map((gate) => (
            <div key={gate.id} className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <XCircle className="size-3 shrink-0 text-destructive/60" />
                <span className="text-[10px] text-muted-foreground">{gate.gate_type} · #{gate.work_item_id.slice(0, 6)}</span>
                {/* S33: owner override 표식(gate_overridden enrich·bypassed_sod)·design-first 머지 후 정합 */}
                {gate.bypassed_sod || gate.overridden_by_member_id ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-warning">
                    <Crown className="size-3 shrink-0" />
                    {t('overriddenTag')}
                    {gate.overridden_by_member_id ? (
                      <span className="text-muted-foreground/70">· {resolveName(gate.overridden_by_member_id)}{gate.overridden_at ? ` · ${new Date(gate.overridden_at).toLocaleDateString()}` : ''}</span>
                    ) : null}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-foreground/80">{gate.resolution_note}</p>
            </div>
          ))}
        </div>
      )}

      {/* S30: 무효화 히스토리(중립 종료·Ban chip) */}
      {voidedGates.length > 0 && (
        <div className="mt-4 space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">{t('voidedHistory')}</p>
          {voidedGates.map((gate) => (
            <div key={gate.id} className="rounded-xl border border-border bg-muted/20 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="chip" className="gap-1"><Ban className="size-3 shrink-0" />{t('voidedBadge')}</Badge>
                <span className="text-[10px] text-muted-foreground">{gate.gate_type} · #{gate.work_item_id.slice(0, 6)}</span>
                {gate.resolver_id ? (
                  <span className="text-[10px] text-muted-foreground/70">{memberNames[gate.resolver_id] ?? gate.resolver_id.slice(0, 6)}</span>
                ) : null}
              </div>
              {gate.resolution_note ? <p className="mt-1 text-xs text-foreground/80">{gate.resolution_note}</p> : null}
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

      {/* S30: 무효화 확인 모달 — AlertTriangle + 영향 카피 + 사유 필수(disabled-until-filled) */}
      {voidModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
            onClick={() => setVoidModal(null)}
            aria-label={t('cancel')}
          />
          <div className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-xl">
            <div className="mb-2 flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              <h3 className="text-sm font-semibold">{t('voidConfirmTitle')}</h3>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">{t('voidImpact')}</p>
            <textarea
              rows={3}
              value={voidModal.reason}
              onChange={(e) => setVoidModal((prev) => prev ? { ...prev, reason: e.target.value } : null)}
              placeholder={t('voidReasonPlaceholder')}
              className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setVoidModal(null)}>{t('cancel')}</Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={!voidModal.reason.trim() || !!resolving}
                onClick={() => void handleVoid()}
              >
                <Ban className="size-3.5" />
                {resolving ? '...' : t('voidConfirm')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* S31: 보류 모달 — 사유 선택 + 무기한/시한부 토글(held_until). 사유 필수 아님(void와 구분). */}
      {holdModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
            onClick={() => setHoldModal(null)}
            aria-label={t('cancel')}
          />
          <div className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-xl">
            <div className="mb-2 flex items-center gap-2">
              <Pause className="size-4 shrink-0 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{t('holdConfirmTitle')}</h3>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">{t('holdImpact')}</p>
            <textarea
              rows={2}
              value={holdModal.reason}
              onChange={(e) => setHoldModal((prev) => prev ? { ...prev, reason: e.target.value } : null)}
              placeholder={t('holdReasonPlaceholder')}
              className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <div className="mt-3 flex items-center gap-4 text-xs text-foreground">
              <label className="flex items-center gap-1.5">
                <input type="radio" name="holdMode" checked={holdModal.indefinite} onChange={() => setHoldModal((p) => p ? { ...p, indefinite: true } : null)} />
                {t('holdIndefinite')}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="holdMode" checked={!holdModal.indefinite} onChange={() => setHoldModal((p) => p ? { ...p, indefinite: false } : null)} />
                {t('holdTimed')}
              </label>
            </div>
            {!holdModal.indefinite ? (
              <input
                type="date"
                value={holdModal.heldUntil}
                onChange={(e) => setHoldModal((prev) => prev ? { ...prev, heldUntil: e.target.value } : null)}
                className="mt-2 h-9 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            ) : null}
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setHoldModal(null)}>{t('cancel')}</Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-primary hover:bg-primary/10 hover:text-primary"
                disabled={(!holdModal.indefinite && !holdModal.heldUntil) || !!resolving}
                onClick={() => void handleHold()}
              >
                <Pause className="size-3.5" />
                {resolving ? '...' : t('holdConfirm')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* S32: 결재자 재지정 모달(parallel gate·admin) */}
      {reassignGateId && projectId ? (
        <GateReassignModal
          gateId={reassignGateId}
          approvers={gateApproversMap[reassignGateId] ?? []}
          projectId={projectId}
          resolveName={resolveName}
          onClose={() => setReassignGateId(null)}
          onResolved={() => void fetchGates()}
        />
      ) : null}

      {/* S33: owner 결재 강제(override) 모달 */}
      {overrideGateId ? (
        <GateOverrideModal
          gateId={overrideGateId}
          onClose={() => setOverrideGateId(null)}
          onResolved={() => void fetchGates()}
        />
      ) : null}
    </div>
  );
}
