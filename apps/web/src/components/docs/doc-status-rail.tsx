'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle, RotateCcw, Shield, ShieldCheck, ShieldX, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem } from '@/components/kanban/types';
import { ProofCapsule, type ProofState } from '@/components/proof-capsule/proof-capsule';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #2955 §3/§7(doc docs-index-reader-redesign-handoff) — 셸 B "에디토리얼 리더"의
 * 상태 헤더 캡슐 + 수직 증거 레일. `doc-gate-section.tsx`(에디터 [slug]/page.tsx 전용,
 * story #2955 PO 보완①로 이번 스코프 밖)와 **같은 API 계약**(GET /api/gates?work_item_id=
 * &work_item_type=doc · GET /api/docs/{id}/revisions · GET /api/team-members · POST
 * /api/docs/{id}/transition · POST /api/gates/{id}/transition)을 그대로 소비하되 — 편집기
 * 표면을 건드리지 않기 위해(에디터는 손대지 않는다는 스코프 경계) 데이터 페치를 이 파일에
 * 독립적으로 다시 구성한다(새 API·새 상태 0 — 표시만 접힌 박스→상시 레일로 승격, 스펙 §6).
 * 서명(고위험) 결재 플로우(GateSignatureApproval)는 리더의 스코프가 아니다(그 경로는
 * 에디터에 남아있다) — 리더는 읽기+저위험 승인/반려까지만 다룬다(§8 미르코 판단: 리더가
 * «쓰기 표면»을 넓히는 건 이번 절단의 목적이 아님, 서명 필요건은 편집기로 유도).
 */

type DocGateState = 'draft' | 'pending' | 'confirmed' | 'denied';

function toState(status: string | undefined): DocGateState {
  if (status === 'pending' || status === 'confirmed' || status === 'denied') return status;
  return 'draft';
}

const STATE_LABEL_KEY: Record<DocGateState, string> = {
  draft: 'docGateRequestReview', pending: 'docGatePending', confirmed: 'docGateConfirmed', denied: 'docGateDenied',
};
const STATE_ICON: Record<DocGateState, typeof Shield> = {
  draft: Shield, pending: Shield, confirmed: ShieldCheck, denied: ShieldX,
};

interface DocRevision {
  id: string;
  created_by?: string | null;
  created_at?: string;
}

function useDocGateData(docId: string, status: string | undefined) {
  const [gate, setGate] = useState<GateItem | null>(null);
  const [revisions, setRevisions] = useState<DocRevision[]>([]);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const [gates, revsJson, membersJson] = await Promise.all([
      fetchWithAuth(`/api/gates?work_item_id=${docId}&work_item_type=doc`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetchWithAuth(`/api/docs/${docId}/revisions`).then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
      fetchWithAuth('/api/team-members').then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
    ]);
    if (signal?.aborted) return;
    const gs = (Array.isArray(gates) ? gates : []) as GateItem[];
    setGate(gs.find((g) => g.status === 'rejected' || g.status === 'denied' || g.status === 'pending') ?? gs[0] ?? null);
    const rv = ((revsJson?.data ?? revsJson) as DocRevision[]) || [];
    setRevisions(Array.isArray(rv) ? [...rv].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')) : []);
    const names: Record<string, string> = {};
    for (const m of ((membersJson?.data ?? []) as { id: string; name: string }[])) names[m.id] = m.name;
    setMemberNames(names);
  }, [docId]);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const resolveName = (id: string | null | undefined) => (id ? (memberNames[id] ?? id.slice(0, 6)) : '—');
  const state = toState(status);
  const isApprover = state === 'pending' && gate?.can_approve === true;

  const docTransition = async (next: string, onDone: () => void) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetchWithAuth(`/api/docs/${docId}/transition`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }),
      });
      if (res.ok) { onDone(); await load(); }
    } finally { setBusy(false); }
  };

  const gateTransition = async (body: Record<string, unknown>, onDone: () => void) => {
    if (!gate || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/gates/${gate.id}/transition`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.ok) { onDone(); await load(); }
    } finally { setBusy(false); }
  };

  return { gate, revisions, busy, state, isApprover, resolveName, docTransition, gateTransition, load };
}

export function DocStatusHeader({ docId, status, onTransitioned }: { docId: string; status: string | undefined; onTransitioned: () => void }) {
  const t = useTranslations('docs');
  const { currentTeamMemberId } = useDashboardContext();
  const { gate, busy, state, isApprover, resolveName, docTransition, gateTransition } = useDocGateData(docId, status);
  const Icon = STATE_ICON[state];
  const fmtDate = (s: string | undefined | null) => (s ? new Date(s).toLocaleString() : '');

  // draft — 접힌 박스의 "검토 요청" CTA를 그대로 상시 승격(§7: 새 상태·새 API 0).
  if (state === 'draft') {
    return (
      <div className="proof-cut flex items-center gap-3 border border-proof-line bg-proof-panel px-4 py-3">
        <Icon className="size-5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t('docGateRequestReviewHint')}</p>
        <Button size="sm" disabled={busy} onClick={() => void docTransition('pending', onTransitioned)}>
          {t('docGateRequestReview')}
        </Button>
      </div>
    );
  }

  return (
    <div className={`proof-cut flex flex-wrap items-center gap-3 border px-4 py-3.5 ${
      state === 'confirmed' ? 'border-success/30 bg-success-tint' : state === 'denied' ? 'border-destructive/30 bg-destructive/10' : 'border-warning/30 bg-warning-tint'
    }`}
    >
      {/* story #2955 §4(대비 주의, 실측 대비표) — 소형 계열색은 텍스트가 아니라 아이콘
          그래픽이라도 배경 위 신뢰도를 아끼려 중립(bg-background) 원 위에 계열색 아이콘만
          쓴다(tint 배경 위 계열색 텍스트 금지 규칙과 같은 결의 안전판 — #2534/#2420 계열). */}
      <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-background">
        <Icon className={`size-4 ${state === 'confirmed' ? 'text-success' : state === 'denied' ? 'text-destructive' : 'text-warning'}`} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-bold text-foreground">{t(STATE_LABEL_KEY[state])}</div>
        {state === 'confirmed' && gate ? (
          <div className="font-mono text-xs text-muted-foreground">{resolveName(gate.resolver_id)} · {fmtDate(gate.resolved_at)}</div>
        ) : state === 'denied' ? (
          <div className="mt-1 text-xs text-foreground">
            <span className="font-medium">{t('docGateDeniedReason')}:</span> {gate?.resolution_note?.trim() || t('docGateNoReason')}
          </div>
        ) : null}
      </div>
      {isApprover ? (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="ghost" disabled={busy} className="gap-1 text-destructive hover:ring-1 hover:ring-inset hover:ring-destructive/60"
            onClick={() => currentTeamMemberId && void gateTransition({ status: 'rejected', resolver_id: currentTeamMemberId }, onTransitioned)}
          >
            <XCircle className="size-3.5" />{t('docGateReject')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} className="gap-1 text-success hover:ring-1 hover:ring-inset hover:ring-success/60"
            onClick={() => currentTeamMemberId && void gateTransition({ status: 'approved', resolver_id: currentTeamMemberId }, onTransitioned)}
          >
            <CheckCircle className="size-3.5" />{t('docGateApprove')}
          </Button>
        </div>
      ) : state === 'pending' ? (
        <span className="shrink-0 text-xs text-muted-foreground">{t('docGateAwaitingGeneric')}</span>
      ) : state === 'denied' ? (
        <Button size="sm" variant="ghost" disabled={busy} className="shrink-0 gap-1" onClick={() => void docTransition('draft', onTransitioned)}>
          <RotateCcw className="size-3.5" />{t('docGateEdit')}
        </Button>
      ) : null}
    </div>
  );
}

type AuditKind = 'request' | 'resubmit' | 'approved' | 'rejected';
interface AuditEvent {
  key: string;
  kind: AuditKind;
  proofState: ProofState;
  name: string;
  at: string;
  version?: number;
  note?: string | null;
}
const AUDIT_KIND_PROOF: Record<AuditKind, ProofState> = {
  request: 'blue', resubmit: 'blue', approved: 'green', rejected: 'red',
};

export function DocEvidenceRail({ docId, status }: { docId: string; status: string | undefined }) {
  const t = useTranslations('docs');
  const { gate, revisions, resolveName } = useDocGateData(docId, status);

  const auditEvents: AuditEvent[] = [];
  revisions.forEach((rev, i) => {
    auditEvents.push({
      key: `rev-${rev.id}`, kind: i === 0 ? 'request' : 'resubmit', proofState: AUDIT_KIND_PROOF[i === 0 ? 'request' : 'resubmit'],
      name: resolveName(rev.created_by), at: rev.created_at ?? '', version: i + 1,
    });
  });
  if (gate?.resolved_at) {
    if (gate.status === 'approved' || gate.status === 'confirmed') {
      auditEvents.push({ key: `gate-ok-${gate.id}`, kind: 'approved', proofState: 'green', name: resolveName(gate.resolver_id), at: gate.resolved_at });
    } else if (gate.status === 'rejected' || gate.status === 'denied') {
      auditEvents.push({ key: `gate-bad-${gate.id}`, kind: 'rejected', proofState: 'red', name: resolveName(gate.resolver_id), at: gate.resolved_at, note: gate.resolution_note });
    }
  }
  auditEvents.sort((a, b) => b.at.localeCompare(a.at));

  const fmtDate = (s: string) => (s ? new Date(s).toLocaleDateString() : '');
  const auditKindLabel: Record<AuditKind, string> = {
    request: t('docGateAuditRequested'), resubmit: t('docGateAuditResubmitted'),
    approved: t('docGateAuditApproved'), rejected: t('docGateAuditRejected'),
  };

  if (auditEvents.length === 0) return null;

  return (
    <div>
      <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {t('docGateAuditTitle')}
      </div>
      {/* 수직 타임라인 — 기존 접힌 리스트(doc-gate-section.tsx)를 상시 레일로 공간화(§3/§6).
          ProofCapsule(density="audit")를 노드 단위로 그대로 재사용(컴포넌트 발명 0) — 이
          컴포넌트는 그 노드들을 잇는 세로선만 새로 그린다(레이아웃 합성, primitive 신규 아님). */}
      <ol className="relative mt-3 space-y-2 border-l border-border pl-4">
        {auditEvents.map((ev) => (
          <li key={ev.key} className="relative">
            <span className="absolute -left-[19px] top-2 size-2 rounded-full border-2 border-background bg-border" aria-hidden="true" />
            <ProofCapsule
              density="audit"
              proofState={ev.proofState}
              // audit 밀도(AuditRow)는 stateLabel을 렌더하지 않지만 타입상 필수(다른 밀도와
              // 공유하는 단일 props 인터페이스) — claim과 동일 문구로 채워 무해하게 충족.
              stateLabel={auditKindLabel[ev.kind]}
              claim={`${auditKindLabel[ev.kind]}${ev.version ? ` (v${ev.version})` : ''}`}
              now={fmtDate(ev.at)}
              human={{ name: ev.name, role: '' }}
            />
            {ev.note?.trim() ? (
              <p className="mt-1 whitespace-pre-wrap border-l-2 border-destructive bg-muted px-2 py-1 text-[11px] leading-[14px] text-muted-foreground">{ev.note}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
