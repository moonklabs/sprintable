'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Shield, ShieldCheck, ShieldX, RotateCcw, Pencil, History, User, ChevronDown,
  CheckCircle, XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { OperatorDropdownSelect, type SelectOption } from '@/components/ui/operator-dropdown-select';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem } from '@/components/kanban/types';
import { deriveRiskLevel, usesSignatureFlow } from '@/components/cage/gate-risk';
import { GateSignatureApproval } from '@/components/cage/gate-signature-approval';

import { fetchWithAuth } from '@/lib/db/client';
import { buildApproverPickerOptions } from '@/lib/approver-picker-options';

/**
 * E-DG S28 + 24f5ae18/34360c54 — doc decision gate UI(doc 상세 상단). S24 hypothesis-gate-badge 어휘 미러·신규 토큰 0.
 * 어휘 2축(혼동 금지):
 *   - doc.status = draft/pending/confirmed/denied → 배지(META map).
 *   - gate-row status = approved/rejected → decider 결재 transition body. 승인→BE가 doc→confirmed, 반려→doc→denied.
 * (34360c54) draft = "검토 요청" CTA 상시 노출(가시성 fix·draft→pending). (24f5ae18) pending+자격자 = in-doc 승인/반려.
 *   자격 = gate.can_approve(BE per-caller·rule A: human+has_project_access+not-author·89484c8c). FE=가시성·실 authz=BE 403.
 *   (구버전 /api/gates/{id}/approvers 는 S32 quorum/parallel 전용·plain doc-gate=빈목록이라 dead였음 → can_approve 로 교체.)
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
  const [busy, setBusy] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false); // 기본 접힘(본문 우선·이력 secondary)
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState('');
  // story #6c89e40d(페드루 PO 판정 2026-08-17, ⓑ) — doc_approval이 ⓐ항목(하위 처방)으로 high 세트에 명시
  // 등재되며 usesSignatureFlow가 항상 true가 되므로, 결재함 카드(approvals-queue.tsx)와
  // 동일 패턴(canonical GateSignatureApproval을 Dialog로) 그대로 배선한다 — 새 UI 발명 0.
  const [sigOpen, setSigOpen] = useState(false);
  const [sigError, setSigError] = useState<string | null>(null);
  // story #3004(선생님 정책 확定 2026-08-24) — 결재선 지정이 상신의 전제(서버가 미지정을
  // 400으로 거부) — draft→pending 클릭이 이제 즉시 전이가 아니라 결재자 픽커를 연다.
  const [approverPickerOpen, setApproverPickerOpen] = useState(false);
  const [approverOptions, setApproverOptions] = useState<SelectOption[]>([]);
  const [loadingApprovers, setLoadingApprovers] = useState(false);
  const [selectedApprover, setSelectedApprover] = useState('');
  const [approverError, setApproverError] = useState<string | null>(null);
  // story #3040 v3 — 동명 표시이름 오지정 실사고(선생님 실계정 vs PO 대행 계정, 둘 다
  // "송윤재") 재발 방지. AC2: 동명이 실재할 때만 경고(음성 대조 — 비동명 org는 항상 false).
  const [approverHasDuplicateNames, setApproverHasDuplicateNames] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const [gates, revsJson, membersJson] = await Promise.all([
      fetchWithAuth(`/api/gates?work_item_id=${docId}&work_item_type=doc`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetchWithAuth(`/api/docs/${docId}/revisions`).then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
      fetchWithAuth('/api/team-members').then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
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
    // (89484c8c) decider 자격 = gate.can_approve(BE per-caller·rule A). 별도 approvers 조회 없음
    // — /api/gates/{id}/approvers 는 S32 quorum/parallel 전용(plain doc-gate=빈목록)이라 dead였음.
  }, [docId]);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const state = toState(status);
  const meta = state ? META[state] : null;
  const MetaIcon = meta?.Icon;
  const isDraft = status === 'draft';
  // 자격 = gate.can_approve(BE per-caller·rule A: human+has_project_access+not-author). FE=가시성·실 authz=BE 403.
  const isApprover = status === 'pending' && gate?.can_approve === true;
  const resolveName = (id: string | null | undefined) => (id ? (memberNames[id] ?? id.slice(0, 6)) : '—');
  const fmtDate = (s: string | undefined) => (s ? new Date(s).toLocaleString() : '');

  // doc.status transition(draft↔pending↔denied). gate-row transition과 별개.
  // story #3004 — draft→pending(상신)은 approverMemberId가 이제 서버 필수(그 외 전이엔 무관·안 실음).
  const docTransition = async (next: string, approverMemberId?: string): Promise<{ ok: boolean; error?: string }> => {
    if (busy) return { ok: false };
    setBusy(true);
    try {
      const body: Record<string, unknown> = { status: next };
      if (next === 'pending' && approverMemberId) body.approver_member_id = approverMemberId;
      const res = await fetchWithAuth(`/api/docs/${docId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) { onTransitioned(); await load(); return { ok: true }; }
      const resBody = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      return { ok: false, error: resBody?.error?.message ?? t('docGateTransitionErrorGeneric') };
    } finally { setBusy(false); }
  };

  // story #3004 — 결재자 픽커 열기(owner/admin·본인 제외 — #3001 위임 픽커와 동형 규율 재사용).
  // story #3231 2라운드(카디르 QA) — /api/org-members가 admin 전용 403으로 잠기면서
  // 일반 Member의 이 픽커가 후보 0명으로 파손됐다. 결재자 지정 전용의 별도 엔드포인트
  // (/api/org-members/eligible-approvers, 어떤 role도 호출 가능·응답은 owner/admin만)로
  // 교체 — 원 org-members roster(admin 전용)는 안 건드린다. 겸사겸사 res.ok 미확인(카디르
  // 지적 — 403이어도 res.json()이 조용히 파싱돼 빈 배열로 저하되던 결함)도 고친다: 이제
  // 실패를 명시 에러로 드러낸다.
  const openApproverPicker = async () => {
    setApproverPickerOpen(true);
    setApproverError(null);
    if (approverOptions.length > 0) return;
    setLoadingApprovers(true);
    try {
      const res = await fetchWithAuth('/api/org-members/eligible-approvers');
      if (!res.ok) {
        setApproverError(t('docGateTransitionErrorGeneric'));
        return;
      }
      const json = await res.json().catch(() => null) as {
        data?: Array<{ id: string; user_id: string | null; name?: string | null; email?: string | null; role: 'owner' | 'admin' | 'member' }>;
      } | null;
      const { options, hasDuplicateNames } = buildApproverPickerOptions(json?.data ?? [], currentTeamMemberId);
      setApproverOptions(options);
      setApproverHasDuplicateNames(hasDuplicateNames);
    } catch {
      setApproverError(t('docGateTransitionErrorGeneric'));
    } finally {
      setLoadingApprovers(false);
    }
  };

  const submitForApproval = async () => {
    if (!selectedApprover) return;
    setApproverError(null);
    const { ok, error } = await docTransition('pending', selectedApprover);
    if (ok) { setApproverPickerOpen(false); setSelectedApprover(''); } else { setApproverError(error ?? null); }
  };

  // gate-row resolution transition(approved/rejected). 성공 시 BE가 doc.status를 confirmed/denied로 flip.
  // story #6c89e40d — 실 envelope({data,error,meta}, story #2500 교정)에서 에러 문구를 뽑아
  // 반환한다(gates/[id]/page.tsx transition()과 동일 파싱 — body.detail은 항상 죽어있던 필드).
  const gateTransition = async (body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => {
    if (!gate || busy) return { ok: false };
    setBusy(true);
    try {
      const res = await fetch(`/api/gates/${gate.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) { onTransitioned(); await load(); return { ok: true }; }
      const resBody = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      return { ok: false, error: resBody?.error?.message ?? t('docGateTransitionErrorGeneric') };
    } finally { setBusy(false); }
  };

  const isSigFlow = gate ? usesSignatureFlow(deriveRiskLevel(gate)) : false;

  const approve = () => {
    if (!currentTeamMemberId) return;
    void gateTransition({ status: 'approved', resolver_id: currentTeamMemberId });
  };

  const submitReject = async () => {
    if (!currentTeamMemberId) return;
    const { ok } = await gateTransition({ status: 'rejected', resolver_id: currentTeamMemberId, note: note.trim() || null });
    if (ok) { setRejectOpen(false); setNote(''); } // 실패 시 모달 유지·재시도 허용
  };

  // story #6c89e40d(ⓑ) — GateSignatureApproval 하나가 승인/반려 둘 다 담당(canonical과 동형).
  // approve만 evidence_viewed=true(canSign 게이팅 자체가 열람 확인 — gates/[id]/page.tsx와 동일 근거).
  const sigApprove = async (reason: string) => {
    if (!currentTeamMemberId) return;
    setSigError(null);
    const { ok, error } = await gateTransition({
      status: 'approved', resolver_id: currentTeamMemberId, note: reason.trim() || null, evidence_viewed: true,
    });
    if (ok) setSigOpen(false); else setSigError(error ?? null);
  };

  const sigReject = async (reason: string) => {
    if (!currentTeamMemberId) return;
    setSigError(null);
    const { ok, error } = await gateTransition({
      status: 'rejected', resolver_id: currentTeamMemberId, note: reason.trim() || null,
    });
    if (ok) setSigOpen(false); else setSigError(error ?? null);
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
      {isDraft && !approverPickerOpen ? (
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
            onClick={() => void openApproverPicker()}
          >
            <Shield className="size-3.5" />
            {t('docGateRequestReview')}
          </Button>
        </div>
      ) : null}

      {/* story #3004 — 결재선 지정이 상신의 전제(서버 필수). "검토 요청" 클릭이 즉시 전이가
          아니라 이 픽커를 연다 — owner/admin·본인 제외로 좁힌다(#3001 위임 픽커와 동형 규율). */}
      {isDraft && approverPickerOpen ? (
        <div className="space-y-1.5">
          {approverError ? (
            <p role="alert" aria-live="assertive" className="text-[11px] text-foreground">{approverError}</p>
          ) : null}
          {/* story #3040 v3 AC2 — 동명 표시이름이 실재할 때만(음성 대조: 비동명 org는 렌더 0). */}
          {approverHasDuplicateNames ? (
            <p role="alert" className="text-[11px] text-warning-strong">{t('docGateApproverPickerDuplicateWarning')}</p>
          ) : null}
          <OperatorDropdownSelect
            value={selectedApprover}
            onValueChange={setSelectedApprover}
            options={approverOptions}
            placeholder={loadingApprovers ? t('docGateApproverPickerLoading') : t('docGateApproverPickerPlaceholder')}
            disabled={loadingApprovers || busy}
          />
          <div className="flex gap-1.5">
            <Button size="sm" className="h-7 flex-1" disabled={!selectedApprover || busy} onClick={() => void submitForApproval()}>
              <Shield className="size-3.5" />
              {t('docGateRequestReview')}
            </Button>
            <Button
              size="sm" variant="ghost" className="h-7 flex-1 text-muted-foreground" disabled={busy}
              onClick={() => { setApproverPickerOpen(false); setSelectedApprover(''); setApproverError(null); }}
            >
              {t('docGateApproverPickerCancel')}
            </Button>
          </div>
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
                className="h-7 gap-1 text-muted-foreground hover:text-destructive hover:ring-1 hover:ring-inset hover:ring-destructive/60"
                disabled={busy}
                onClick={() => { if (isSigFlow) { setSigError(null); setSigOpen(true); } else setRejectOpen(true); }}
              >
                <XCircle className="size-3.5" />
                {t('docGateReject')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                // story #9853aa2f(§AC7 가드, 페드루 지적 2026-08-17) — tint 배경 위 계열색
                // 글자는 hover 순간 대비 최저점(#2420 규칙). approvals-queue.tsx:268/
                // workflow-line-editor-section.tsx:227과 동일 처방(rest=text-success 유지,
                // hover만 text-foreground)으로 통일 — 새 패턴 발명 0.
                className="h-7 gap-1 text-success hover:bg-success-tint hover:text-foreground"
                disabled={busy}
                onClick={() => { if (isSigFlow) { setSigError(null); setSigOpen(true); } else approve(); }}
              >
                <CheckCircle className="size-3.5" />
                {t('docGateApprove')}
              </Button>
            </>
          ) : state === 'pending' ? (
            /* ② pending + author/비자격자 = 검토자 응답 대기(액션 없음·self-approval 금지). */
            <span className="text-xs text-muted-foreground">
              {t('docGateAwaitingGeneric')}
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
          <p className="text-xs font-medium text-foreground">{t('docGateDeniedReason')}</p>
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
            <span className="text-muted-foreground">({auditEvents.length})</span>
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
                        <p className="mt-1 whitespace-pre-wrap rounded border-l-2 border-destructive bg-muted px-2 py-1 text-[11px] leading-[14px] text-muted-foreground">{ev.note}</p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* 반려 사유 모달 — story #2061: 공용 Dialog(base-ui, 포커스트랩+Esc+반환 내장)로 교체. */}
      {rejectOpen ? (
        <Dialog open={rejectOpen} onOpenChange={(open) => { if (!open && !busy) setRejectOpen(false); }}>
          <DialogContent className="max-w-sm" showCloseButton={false}>
            <div className="mb-3 flex items-center gap-2">
              <ShieldX className="size-4 shrink-0 text-destructive" />
              <DialogTitle className="text-sm font-semibold">{t('docGateRejectModalTitle')}</DialogTitle>
            </div>
            <label className="mb-1.5 block text-[11.5px] text-muted-foreground">{t('docGateRejectReasonLabel')}</label>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('docGateRejectReasonPlaceholder')}
              className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRejectOpen(false)}>{t('cancel')}</Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-destructive hover:text-destructive hover:ring-1 hover:ring-inset hover:ring-destructive/60"
                disabled={busy}
                onClick={() => void submitReject()}
              >
                <ShieldX className="size-3.5" />
                {busy ? '...' : t('docGateRejectConfirm')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {/* story #6c89e40d(ⓑ) — 고위험 서명 모달. approvals-queue.tsx와 동일 컴포넌트를 동일
          Dialog 패턴으로(canonical 상세와 1:1, 새 UI 발명 0). */}
      {sigOpen && gate ? (
        <Dialog open={sigOpen} onOpenChange={(open) => { if (!open && !busy) setSigOpen(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('docGateLabel')}</DialogTitle>
            </DialogHeader>
            <GateSignatureApproval
              gate={gate}
              resolving={busy}
              error={sigError}
              onApprove={(reason) => void sigApprove(reason)}
              onReject={(reason) => void sigReject(reason)}
              compact
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
