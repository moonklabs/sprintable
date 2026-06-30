'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Shield, ShieldCheck, ShieldX, RotateCcw, Pencil, History, User, ChevronDown,
  CheckCircle, XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem } from '@/components/kanban/types';

/**
 * E-DG S28 + 24f5ae18/34360c54 — doc decision gate UI(doc 상세 상단). S24 hypothesis-gate-badge 어휘 미러·신규 토큰 0.
 * 어휘 2축(혼동 금지):
 *   - doc.status = draft/pending/confirmed/denied → 배지(META map).
 *   - gate-row status = approved/rejected → decider 결재 transition body. 승인→BE가 doc→confirmed, 반려→doc→denied.
 * (34360c54) draft = "검토 요청" CTA 상시 노출(가시성 fix·draft→pending). (24f5ae18) pending+자격자 = in-doc 승인/반려.
 *   자격 = GET /api/gates/{id}/approvers 에 currentTeamMemberId 포함(저자 자기승인 금지·BE can_approve 강제·fail-closed).
 * audit 타임라인 = revisions(요청/재요청) + 현재 gate resolution(승인/반려+사유) display 병합.
 *   ⚠️ 사이클별 풍부한 per-transition 이벤트 로그는 BE event-log 의존(디디 scope-TBD). v1 = 보유 데이터 병합.
 * 반려 사유 = doc gate(work_item_type='doc')의 resolution_note. revision = GET /docs/{id}/revisions(org-scoped IDOR fix).
 */
type DocGateState = 'pending' | 'confirmed' | 'denied';

const META: Record<DocGateState, { variant: 'warning' | 'success' | 'destructive'; Icon: typeof Shield; labelKey: string }> = {
  pending: { variant: 'warning', Icon: Shield, labelKey: 'docGatePending' },
  confirmed: { variant: 'success', Icon: ShieldCheck, labelKey: 'docGateConfirmed' },
  denied: { variant: 'destructive', Icon: ShieldX, labelKey: 'docGateDenied' },
};

interface DocRevision {
  id: string;
  created_by?: string | null;
  created_at?: string;
}

type AuditKind = 'request' | 'resubmit' | 'approved' | 'rejected';

interface AuditEvent {
  key: string;
  kind: AuditKind;
  name: string;
  at: string;
  version?: number;
  note?: string | null;
}

const AUDIT_META: Record<AuditKind, { dot: string; Icon: typeof Shield; labelKey: string }> = {
  request: { dot: 'bg-info-tint text-info', Icon: Shield, labelKey: 'docGateAuditRequested' },
  resubmit: { dot: 'bg-muted text-muted-foreground', Icon: Pencil, labelKey: 'docGateAuditResubmitted' },
  approved: { dot: 'bg-success-tint text-success', Icon: CheckCircle, labelKey: 'docGateAuditApproved' },
  rejected: { dot: 'bg-destructive/10 text-destructive', Icon: XCircle, labelKey: 'docGateAuditRejected' },
};

function toState(status: string | undefined): DocGateState | null {
  if (status === 'pending' || status === 'confirmed' || status === 'denied') return status;
  return null; // draft 등은 배지 미표시
}

// approvers 응답 형상 방어 파싱: 배열 | {data:[]} | {approvers:[]}, 각 항목서 member id 추출. any 금지(strict).
function extractApproverIds(raw: unknown): string[] {
  const obj = raw as { data?: unknown; approvers?: unknown } | null;
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray(obj?.data)
      ? (obj!.data as unknown[])
      : Array.isArray(obj?.approvers)
        ? (obj!.approvers as unknown[])
        : [];
  const ids: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string') { ids.push(item); continue; }
    const r = item as Record<string, unknown>;
    const id = r?.approver_member_id ?? r?.member_id ?? r?.team_member_id ?? r?.id;
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

export function DocGateSection({
  docId,
  status,
  onTransitioned,
}: {
  docId: string;
  status: string | undefined;
  onTransitioned: () => void;
}) {
  const t = useTranslations('docs');
  const { currentTeamMemberId } = useDashboardContext();
  const [gate, setGate] = useState<GateItem | null>(null);
  const [revisions, setRevisions] = useState<DocRevision[]>([]);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [approverIds, setApproverIds] = useState<string[] | null>(null); // null = 미로드/실패 → fail-closed(버튼 숨김)
  const [busy, setBusy] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false); // 기본 접힘(본문 우선·이력 secondary)
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    const [gates, revsJson, membersJson] = await Promise.all([
      fetch(`/api/gates?work_item_id=${docId}&work_item_type=doc`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`/api/docs/${docId}/revisions`).then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
      fetch('/api/team-members').then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
    ]);
    if (signal?.aborted) return;
    const gs = (Array.isArray(gates) ? gates : []) as GateItem[];
    // 반려/검토중 gate 우선(사유·진행 상태)·없으면 최신.
    const picked = gs.find((g) => g.status === 'rejected' || g.status === 'denied' || g.status === 'pending') ?? gs[0] ?? null;
    setGate(picked);
    const rv = ((revsJson?.data ?? revsJson) as DocRevision[]) || [];
    setRevisions(Array.isArray(rv) ? [...rv].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')) : []);
    const names: Record<string, string> = {};
    for (const m of ((membersJson?.data ?? []) as { id: string; name: string }[])) names[m.id] = m.name;
    setMemberNames(names);
    // (24f5ae18) decider 게이팅: pending + gate 있을 때만 자격자 목록 조회. 실패=null(fail-closed).
    if (status === 'pending' && picked) {
      const approversRaw = await fetch(`/api/gates/${picked.id}/approvers`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (signal?.aborted) return;
      setApproverIds(approversRaw == null ? null : extractApproverIds(approversRaw));
    } else {
      setApproverIds(null);
    }
  }, [docId, status]);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const state = toState(status);
  const meta = state ? META[state] : null;
  const MetaIcon = meta?.Icon;
  const isDraft = status === 'draft';
  const isApprover = status === 'pending' && !!currentTeamMemberId && (approverIds?.includes(currentTeamMemberId) ?? false);
  const resolveName = (id: string | null | undefined) => (id ? (memberNames[id] ?? id.slice(0, 6)) : '—');
  const fmtDate = (s: string | undefined) => (s ? new Date(s).toLocaleString() : '');
  const reviewerName = approverIds && approverIds.length > 0 ? resolveName(approverIds[0]) : null;

  // doc.status transition(draft↔pending↔denied). gate-row transition과 별개.
  const docTransition = async (next: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/docs/${docId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) { onTransitioned(); await load(); }
    } finally { setBusy(false); }
  };

  // gate-row resolution transition(approved/rejected). 성공 시 BE가 doc.status를 confirmed/denied로 flip.
  const gateTransition = async (body: Record<string, unknown>): Promise<boolean> => {
    if (!gate || busy) return false;
    setBusy(true);
    try {
      const res = await fetch(`/api/gates/${gate.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) { onTransitioned(); await load(); return true; }
      return false;
    } finally { setBusy(false); }
  };

  const approve = () => {
    if (!currentTeamMemberId) return;
    void gateTransition({ status: 'approved', resolver_id: currentTeamMemberId });
  };

  const submitReject = async () => {
    if (!currentTeamMemberId) return;
    const ok = await gateTransition({ status: 'rejected', resolver_id: currentTeamMemberId, note: note.trim() || null });
    if (ok) { setRejectOpen(false); setNote(''); } // 실패 시 모달 유지·재시도 허용
  };

  // audit 타임라인 이벤트(display 병합): revision = 검토요청/재검토요청, gate resolution = 승인/반려(+사유).
  const auditEvents: AuditEvent[] = [];
  revisions.forEach((rev, i) => {
    auditEvents.push({
      key: `rev-${rev.id}`,
      kind: i === 0 ? 'request' : 'resubmit',
      name: resolveName(rev.created_by),
      at: rev.created_at ?? '',
      version: i + 1,
    });
  });
  if (gate && gate.resolved_at) {
    if (gate.status === 'approved' || gate.status === 'confirmed') {
      auditEvents.push({ key: `gate-ok-${gate.id}`, kind: 'approved', name: resolveName(gate.resolver_id), at: gate.resolved_at });
    } else if (gate.status === 'rejected' || gate.status === 'denied') {
      auditEvents.push({ key: `gate-bad-${gate.id}`, kind: 'rejected', name: resolveName(gate.resolver_id), at: gate.resolved_at, note: gate.resolution_note });
    }
  }
  auditEvents.sort((a, b) => b.at.localeCompare(a.at)); // 최신 우선

  // draft = CTA 상시 노출(34360c54). 그 외엔 상태/이력 없으면 미표시(노이즈 0).
  const hasHistory = gate != null || revisions.length > 0;
  if (!isDraft && !state && !hasHistory) return null;

  return (
    <section aria-label={t('docGateLabel')} className="mb-4 max-h-[40vh] space-y-2 overflow-y-auto rounded-xl border border-border bg-muted/20 p-3">
      {/* (34360c54) draft = "검토 요청" 상시 entry(Shield + 안내 + primary 버튼 → draft→pending). 저자 자기승인 아님. */}
      {isDraft ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">
            <Shield className="size-4" />
          </span>
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">{t('docGateRequestReviewHint')}</span>
          <Button
            size="sm"
            variant="default"
            className="h-7 shrink-0 gap-1"
            disabled={busy}
            onClick={() => void docTransition('pending')}
          >
            <Shield className="size-3.5" />
            {t('docGateRequestReview')}
          </Button>
        </div>
      ) : null}

      {meta && MetaIcon ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={meta.variant} className="shrink-0 gap-1">
            <MetaIcon className="size-3 shrink-0" />
            {t(meta.labelKey)}
          </Badge>

          {/* ③ pending + decider 자격자 = in-doc 승인/반려(반려는 사유 모달 경유). */}
          {isApprover ? (
            <>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                disabled={busy}
                onClick={() => setRejectOpen(true)}
              >
                <XCircle className="size-3.5" />
                {t('docGateReject')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-success hover:bg-success-tint hover:text-success"
                disabled={busy}
                onClick={approve}
              >
                <CheckCircle className="size-3.5" />
                {t('docGateApprove')}
              </Button>
            </>
          ) : state === 'pending' ? (
            /* ② pending + author/비자격자 = 검토자 응답 대기(액션 없음·self-approval 금지). */
            <span className="text-xs text-muted-foreground">
              {reviewerName ? t('docGateAwaitingReviewer', { name: reviewerName }) : t('docGateAwaitingGeneric')}
            </span>
          ) : state === 'confirmed' && gate ? (
            /* ④ confirmed = 결재자 + 시각. */
            <span className="inline-flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><User className="size-3" />{resolveName(gate.resolver_id)}</span>
              {gate.resolved_at ? <span>· {fmtDate(gate.resolved_at)}</span> : null}
            </span>
          ) : state === 'denied' ? (
            /* ⑤ denied = 수정 진입(denied→draft). 사유는 아래 deny 섹션. */
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 gap-1 text-foreground hover:bg-accent"
              disabled={busy}
              onClick={() => void docTransition('draft')}
            >
              <RotateCcw className="size-3.5" />
              {t('docGateEdit')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* 반려 섹션: 사유 + 결재자 + 시각(현재 상태 prominent surface). */}
      {state === 'denied' ? (
        <div className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
          <p className="text-xs font-medium text-destructive">{t('docGateDeniedReason')}</p>
          <p className="whitespace-pre-wrap text-xs text-foreground">{gate?.resolution_note?.trim() || t('docGateNoReason')}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1"><User className="size-3" />{resolveName(gate?.resolver_id)}</span>
            {gate?.resolved_at ? <span>· {fmtDate(gate.resolved_at)}</span> : null}
          </div>
        </div>
      ) : null}

      {/* (crux5) 결재 audit 타임라인: revision + gate resolution 병합·접기 기본·바운드 scroll. */}
      {auditEvents.length > 0 ? (
        <div className="space-y-1 border-t border-border pt-2">
          <button
            type="button"
            onClick={() => setAuditOpen((o) => !o)}
            aria-expanded={auditOpen}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <History className="size-3 shrink-0" />
            {t('docGateAuditTitle')}
            <span className="text-muted-foreground/70">({auditEvents.length})</span>
            <ChevronDown className={`size-3 shrink-0 transition-transform ${auditOpen ? 'rotate-180' : ''}`} />
          </button>
          {auditOpen ? (
            <ul className="max-h-48 space-y-0 overflow-y-auto pr-1">
              {auditEvents.map((ev, i) => {
                const am = AUDIT_META[ev.kind];
                const AIcon = am.Icon;
                const isLast = i === auditEvents.length - 1;
                return (
                  <li key={ev.key} className="relative grid grid-cols-[18px_1fr] gap-2 pb-2.5">
                    {!isLast ? <span className="absolute left-[8px] top-4 bottom-0 w-px bg-border" aria-hidden /> : null}
                    <span className={`z-[1] grid size-[18px] place-items-center rounded-full ${am.dot}`}>
                      <AIcon className="size-2.5" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs text-foreground">
                        {t('docGateAuditBy', { name: ev.name, action: t(am.labelKey) })}
                        {ev.version ? <span className="text-muted-foreground"> (v{ev.version})</span> : null}
                      </p>
                      <p className="mt-px text-[10.5px] text-muted-foreground">{fmtDate(ev.at)}</p>
                      {ev.note?.trim() ? (
                        <p className="mt-1 whitespace-pre-wrap rounded border-l-2 border-destructive bg-muted px-2 py-1 text-[11px] text-muted-foreground">{ev.note}</p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* 반려 사유 모달(in-doc·hand-rolled — Dialog primitive 아님·cage/doc-gate 컨벤션 미러). */}
      {rejectOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
            onClick={() => { if (!busy) setRejectOpen(false); }}
            aria-label={t('cancel')}
          />
          <div className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-xl">
            <div className="mb-3 flex items-center gap-2">
              <ShieldX className="size-4 shrink-0 text-destructive" />
              <h3 className="text-sm font-semibold">{t('docGateRejectModalTitle')}</h3>
            </div>
            <label className="mb-1.5 block text-[11.5px] text-muted-foreground">{t('docGateRejectReasonLabel')}</label>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('docGateRejectReasonPlaceholder')}
              className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRejectOpen(false)}>{t('cancel')}</Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy}
                onClick={() => void submitReject()}
              >
                <ShieldX className="size-3.5" />
                {busy ? '...' : t('docGateRejectConfirm')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
