'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { CheckCircle, ExternalLink, RotateCcw, Shield, ShieldCheck, ShieldX, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem } from '@/components/kanban/types';
import { deriveRiskLevel, usesSignatureFlow } from '@/components/cage/gate-risk';
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
 *
 * ⚠️PR#3384 카디르 QA CRITICAL(2026-08-23) — 최초 구현은 usesSignatureFlow/deriveRiskLevel을
 * 안 태우고 승인/반려를 바로 쐈다. doc_approval은 gate_service.derive_risk_grade가 org
 * posture=permissive가 아닌 한 항상 high로 등재(§ _HIGH_RISK_GATE_TYPES, story #6c89e40d
 * ⓐ' PO 판정)돼 usesSignatureFlow가 거의 항상 true — 그 결과 ①승인: BE가 evidence_viewed
 * 없는 approve를 강제 블록(422)하는데 이 컴포넌트는 그 실패를 삼켰다(에러 표시 0) ②반려:
 * BE 강제 블록이 approved 전이에만 걸려 있어 서명·사유 없이 그대로 성공 — 신중 결재(서명
 * 의식) 우회. 처방: isSigFlow===true면 승인/반려 버튼 자체를 없애고 에디터([slug]/page.tsx,
 * GateSignatureApproval 보유)로 유도만 한다(리더에 서명 다이얼로그를 새로 짓지 않는다 —
 * 그건 여전히 스코프 밖) — isSigFlow===false(permissive posture)일 때만 바로 아래의 원탭
 * 승인/반려가 실행된다. 모든 전이는 실패 시 에러를 상시 표시(침묵 실패 금지).
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

// export: 테스트 전용(doc-status-rail.test.tsx) — isSigFlow일 때 gateTransition 자체가
// 거부하는 데이터 레이어 안전판을 UI(버튼 미노출) 우회 없이 직접 검증하기 위함(PR#3384
// 카디르 QA 선택 처방 — "안전판 줄을 빼도 기존 테스트가 안 깨지는" 뮤테이션 gap을 닫는다).
export function useDocGateData(docId: string, status: string | undefined) {
  const [gate, setGate] = useState<GateItem | null>(null);
  const [revisions, setRevisions] = useState<DocRevision[]>([]);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const t = useTranslations('docs');
  const resolveName = (id: string | null | undefined) => (id ? (memberNames[id] ?? id.slice(0, 6)) : '—');
  const state = toState(status);
  const isApprover = state === 'pending' && gate?.can_approve === true;
  // ⚠️PR#3384 QA CRITICAL — doc_approval은 org posture가 permissive가 아닌 한 항상 high
  // (derive_risk_grade의 _HIGH_RISK_GATE_TYPES 명시 등재). isSigFlow===true면 아래
  // gateTransition을 절대 직접 쏘지 않는다(호출부가 대신 에디터로 유도).
  const isSigFlow = gate ? usesSignatureFlow(deriveRiskLevel(gate)) : false;

  async function parseErrorBody(res: Response): Promise<string> {
    const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
    return body?.error?.message ?? t('docGateTransitionErrorGeneric');
  }

  const docTransition = async (next: string, onDone: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/docs/${docId}/transition`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }),
      });
      if (res.ok) { onDone(); await load(); } else { setError(await parseErrorBody(res)); }
    } finally { setBusy(false); }
  };

  const gateTransition = async (body: Record<string, unknown>, onDone: () => void) => {
    // ⚠️PR#3384 QA CRITICAL — 데이터 레이어 안전판(버튼을 안 그리는 것만으론 부족, 우회 금지를
    // 이 함수 자체가 강제). isSigFlow면 호출부가 잘못 배선되더라도 여기서 막는다.
    if (!gate || busy || isSigFlow) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetchWithAuth(`/api/gates/${gate.id}/transition`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.ok) { onDone(); await load(); } else { setError(await parseErrorBody(res)); }
    } finally { setBusy(false); }
  };

  return { gate, revisions, busy, error, state, isApprover, isSigFlow, resolveName, docTransition, gateTransition, load };
}

export function DocStatusHeader({ docId, status, editHref, onTransitioned }: { docId: string; status: string | undefined; editHref: string; onTransitioned: () => void }) {
  const t = useTranslations('docs');
  const { currentTeamMemberId } = useDashboardContext();
  const { gate, busy, error, state, isApprover, isSigFlow, resolveName, docTransition, gateTransition } = useDocGateData(docId, status);
  const Icon = STATE_ICON[state];
  const fmtDate = (s: string | undefined | null) => (s ? new Date(s).toLocaleString() : '');

  const errorBanner = error ? (
    <p className="mt-1.5 basis-full text-xs text-destructive">{error}</p>
  ) : null;

  // draft — 접힌 박스의 "검토 요청" CTA를 그대로 상시 승격(§7: 새 상태·새 API 0).
  if (state === 'draft') {
    return (
      <div className="proof-surface proof-surface-lift flex flex-wrap items-center gap-3 border border-proof-line bg-proof-panel px-4 py-3">
        <Icon className="size-5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t('docGateRequestReviewHint')}</p>
        <Button size="sm" className="focus-outset" disabled={busy} onClick={() => void docTransition('pending', onTransitioned)}>
          {t('docGateRequestReview')}
        </Button>
        {errorBanner}
      </div>
    );
  }

  return (
    <div className={`proof-surface proof-surface-lift flex flex-wrap items-center gap-3 border px-4 py-3.5 ${
      state === 'confirmed' ? 'border-success/30 bg-success-tint' : state === 'denied' ? 'border-destructive/30 bg-destructive-tint' : 'border-warning/30 bg-warning-tint'
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
        {/* story #2967 — resolveName은 한글 사람 이름이라 mono 걷음(동일 결함 클래스). */}
        {state === 'confirmed' && gate ? (
          <div className="text-xs text-muted-foreground">{resolveName(gate.resolver_id)} · {fmtDate(gate.resolved_at)}</div>
        ) : state === 'denied' ? (
          <div className="mt-1 text-xs text-foreground">
            <span className="font-medium">{t('docGateDeniedReason')}:</span> {gate?.resolution_note?.trim() || t('docGateNoReason')}
          </div>
        ) : null}
      </div>
      {isApprover && isSigFlow ? (
        // ⚠️PR#3384 QA CRITICAL 처방 — 서명(고위험) 결재는 리더에서 직행 처리하지 않는다.
        // 승인/반려 버튼 자체를 없애고 GateSignatureApproval을 가진 에디터로만 유도한다
        // (우회 경로 자체를 안 만든다 — 반려도 동일 취급, 비대칭 예외 없음).
        <Button asChild size="sm" variant="outline" className="shrink-0 gap-1.5">
          <Link href={editHref}>
            <ExternalLink className="size-3.5" />{t('docGateGoToEditorSign')}
          </Link>
        </Button>
      ) : isApprover ? (
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
      {errorBanner}
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

  // story #2967(선생님 실사용 판정 ④) — 이력 1~2건일 때 316px 세로 레일(선+노드 여백)이
  // 텅 빈 공간을 만들어 판이 왼쪽으로 쏠려 보였다. 노드 2개 이하면 세로 타임라인(선·점) 대신
  // 컴팩트 가로 스트립으로 강등 — ProofCapsule(density="audit") 자체는 그대로 재사용(발명
  // 0), 세로선 장식만 걷어 짧은 이력이 "미완성"이 아니라 "원래 이 정도"로 읽히게 한다.
  if (auditEvents.length <= 2) {
    return (
      <div className="flex flex-col gap-2">
        {auditEvents.map((ev) => (
          <ProofCapsule
            key={ev.key}
            density="audit"
            proofState={ev.proofState}
            stateLabel={auditKindLabel[ev.kind]}
            claim={`${auditKindLabel[ev.kind]}${ev.version ? ` (v${ev.version})` : ''}`}
            now={fmtDate(ev.at)}
            human={{ name: ev.name, role: '' }}
          />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="text-[12px] font-semibold text-muted-foreground">
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
