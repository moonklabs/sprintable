'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { actorRowLabels, memberLookup } from '@/lib/member-display';
import { Button } from '@/components/ds/button';
import { Icon, type IconName } from '@/components/ds/icon';
import { Card } from '@/components/ds/card';
import { SectionHeader } from '@/components/ds/section-header';
import { cn } from '@/lib/utils';
import { RowName } from '@/components/shared/row-name';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem } from '@/components/kanban/types';
import { deriveRiskLevel, usesSignatureFlow } from '@/components/cage/gate-risk';
import { fetchWithAuth } from '@/lib/db/client';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';
import { ORG_NAMES_URL } from '@/hooks/use-member-name-fallback';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

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
// story 4892 (UI-9 문서 상세 열) — 상태 아이콘은 ds Icon 이름(방패 · 확인된 방패 · 막힌 방패 자리). 데이터 · 전이 로직은 그대로, 모양만 ds 부품.
const STATE_ICON: Record<DocGateState, IconName> = {
  draft: 'shield', pending: 'shield', confirmed: 'verified_user', denied: 'block',
};
const STATE_ICON_TONE: Record<DocGateState, string> = {
  draft: 'text-ds-ink-3', pending: 'text-ds-ink', confirmed: 'text-ds-done', denied: 'text-ds-failed',
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
      // [SID:4300] 이름만 쓰는 표 — 비활성 에이전트도 «목록이 거른 것»이라 비활성까지 싣는 조직 원천(떠난 사람은 BE 4303 대기).
      fetchWithAuth(ORG_NAMES_URL).then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
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
  const tc = useTranslations('common');
  // [SID:4286] 구성원 id 조각(앞 6자)을 이름 칸에 싣지 않는다 — 표에 없음 → «알 수 없는 구성원». 이름 표는 게이트 · 개정 목록과
  // 같은 load(Promise.all)에서 함께 채워져, 이름을 찾는 시점엔 늘 다 불러온 상태(불러오는 중 갈래 없음 → loaded: true).
  const resolveName = (id: string | null | undefined) => (id ? (memberLookup(memberNames, id, tc, { loaded: true })?.label ?? '') : '—');
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
      const res = await fetchWithAuth(`/api/gates/${gate.id}/transition`, { timeoutMs: LONG_ROUTES.gateTransition.browserMs,
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.ok) { onDone(); await load(); } else { setError(await parseErrorBody(res)); }
    } finally { setBusy(false); }
  };

  return { gate, revisions, busy, error, state, isApprover, isSigFlow, resolveName, docTransition, gateTransition, load };
}

export function DocStatusHeader({ docId, status, editHref, onTransitioned }: { docId: string; status: string | undefined; editHref: string; onTransitioned: () => void }) {
  const t = useTranslations('docs');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const { currentTeamMemberId } = useDashboardContext();
  const { gate, busy, error, state, isApprover, isSigFlow, resolveName, docTransition, gateTransition } = useDocGateData(docId, status);
  // story #3493 — gate 시각은 "기록"(정본 formatRelativeTime).
  const fmtDate = (s: string | undefined | null) => (s ? formatViewerRelativeTime(s, locale, displayTimezone) : '');

  const errorBanner = error ? (
    <p className="mt-1.5 basis-full break-keep text-ds-small text-ds-failed">{error}</p>
  ) : null;

  // draft — 접힌 박스의 "검토 요청" CTA를 그대로 상시 승격(§7: 새 상태·새 API 0).
  if (state === 'draft') {
    return (
      <Card data-testid="doc-status-header" data-state="draft" className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Icon name={STATE_ICON.draft} size={20} className={cn('shrink-0', STATE_ICON_TONE.draft)} />
        <p className="m-0 min-w-0 flex-1 break-keep text-ds-body text-ds-ink-2">{t('docGateRequestReviewHint')}</p>
        <Button variant="primary" disabled={busy} onClick={() => void docTransition('pending', onTransitioned)}>
          {t('docGateRequestReview')}
        </Button>
        {errorBanner}
      </Card>
    );
  }

  return (
    // story 4892 — 면 색(승인 = done-soft · 반려 = failed-soft · 검토 중 = 중립)은 «면»이고 글은 전부 ds ink(색 면 위 흐린 글 금지 — story #3865 대비 규율 그대로).
    <Card
      data-testid="doc-status-header"
      data-state={state}
      className={cn('flex flex-wrap items-center gap-3 px-4 py-3', state === 'confirmed' ? 'bg-ds-done-soft' : state === 'denied' ? 'bg-ds-failed-soft' : 'bg-ds-surface')}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-ds-control bg-ds-background">
        <Icon name={STATE_ICON[state]} size={16} className={STATE_ICON_TONE[state]} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-ds-card-title font-semibold text-ds-ink">{t(STATE_LABEL_KEY[state])}</div>
        {/* story #2967 — resolveName은 한글 사람 이름이라 mono 걷음(동일 결함 클래스). */}
        {state === 'confirmed' && gate ? (
          <div className="text-ds-small text-ds-ink">{resolveName(gate.resolver_id)} · {fmtDate(gate.resolved_at)}</div>
        ) : state === 'denied' ? (
          <div className="mt-1 break-keep text-ds-small text-ds-ink [overflow-wrap:anywhere]">
            <span className="font-semibold">{t('docGateDeniedReason')}:</span> {gate?.resolution_note?.trim() || t('docGateNoReason')}
          </div>
        ) : null}
      </div>
      {isApprover && isSigFlow ? (
        // ⚠️PR#3384 QA CRITICAL 처방 — 서명(고위험) 결재는 리더에서 직행 처리하지 않는다.
        // 승인/반려 버튼 자체를 없애고 GateSignatureApproval을 가진 에디터로만 유도한다
        // (우회 경로 자체를 안 만든다 — 반려도 동일 취급, 비대칭 예외 없음).
        <Button asChild variant="secondary" className="shrink-0">
          <Link href={editHref}>
            <Icon name="open_in_new" size={14} />{t('docGateGoToEditorSign')}
          </Link>
        </Button>
      ) : isApprover ? (
        <div className="flex shrink-0 gap-2">
          {/* story #3334 — 반려(변경 요청)는 gate_type 무관 사유 필수(서버 422). 이 리더 헤더엔 사유 입력창이 없으므로, 반려는 사유 모달을 가진 에디터
              (doc-gate-section.tsx의 rejectOpen 다이얼로그)로 유도한다 — 위 고위험 분기와 같은 원칙("여기서 직행 처리 안 함, 반려는 비대칭 예외 없이 동일 취급").
              승인은 사유가 필요 없으므로 기존처럼 원탭 그대로. */}
          <Button asChild variant="danger">
            <Link href={editHref}>
              <Icon name="cancel" size={14} />{t('docGateReject')}
            </Link>
          </Button>
          <Button variant="secondary" disabled={busy} iconStart={<Icon name="check_circle" size={14} />}
            onClick={() => currentTeamMemberId && void gateTransition({ status: 'approved', resolver_id: currentTeamMemberId }, onTransitioned)}
          >
            {t('docGateApprove')}
          </Button>
        </div>
      ) : state === 'pending' ? (
        <span className="shrink-0 break-keep text-ds-small text-ds-ink">{t('docGateAwaitingGeneric')}</span>
      ) : state === 'denied' ? (
        <Button variant="quiet" disabled={busy} iconStart={<Icon name="undo" size={14} />} onClick={() => void docTransition('draft', onTransitioned)}>
          {t('docGateEdit')}
        </Button>
      ) : null}
      {errorBanner}
    </Card>
  );
}

type AuditKind = 'request' | 'resubmit' | 'approved' | 'rejected';
interface AuditEvent {
  key: string;
  kind: AuditKind;
  name: string;
  /** [SID:4311 PR 3] 행위자 id — 같은 이름 서로 다른 사람 둘이면 «· ID 앞 8자» 꼬리의 기준. */
  actorId: string | null;
  at: string;
  version?: number;
  note?: string | null;
}

export function DocEvidenceRail({ docId, status }: { docId: string; status: string | undefined }) {
  const t = useTranslations('docs');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const { gate, revisions, resolveName } = useDocGateData(docId, status);

  const auditEvents: AuditEvent[] = [];
  revisions.forEach((rev, i) => {
    auditEvents.push({
      key: `rev-${rev.id}`, kind: i === 0 ? 'request' : 'resubmit',
      name: resolveName(rev.created_by), actorId: rev.created_by ?? null, at: rev.created_at ?? '', version: i + 1,
    });
  });
  if (gate?.resolved_at) {
    if (gate.status === 'approved' || gate.status === 'confirmed') {
      auditEvents.push({ key: `gate-ok-${gate.id}`, kind: 'approved', name: resolveName(gate.resolver_id), actorId: gate.resolver_id, at: gate.resolved_at });
    } else if (gate.status === 'rejected' || gate.status === 'denied') {
      auditEvents.push({ key: `gate-bad-${gate.id}`, kind: 'rejected', name: resolveName(gate.resolver_id), actorId: gate.resolver_id, at: gate.resolved_at, note: gate.resolution_note });
    }
  }
  auditEvents.sort((a, b) => b.at.localeCompare(a.at));
  // [SID:4311 PR 3] 감사 이력 줄 — 같은 이름 서로 다른 사람 둘이면 «· ID 앞 8자»(행위자 id마다 한 번). 읽는 글자(label)에만 · 머리글자는 이름.
  const auditLabels = actorRowLabels(auditEvents.map((ev) => ({ id: ev.actorId, label: ev.name })));

  // story #3493 — 감사 이력 항목 시각은 "기록"(정본 formatRelativeTime).
  const fmtDate = (s: string) => (s ? formatViewerRelativeTime(s, locale, displayTimezone) : '');
  const auditKindLabel: Record<AuditKind, string> = {
    request: t('docGateAuditRequested'), resubmit: t('docGateAuditResubmitted'),
    approved: t('docGateAuditApproved'), rejected: t('docGateAuditRejected'),
  };

  if (auditEvents.length === 0) return null;

  // story 4892 (UI-9 문서 상세 열) — 감사 이력 = ds 부품 한 줄 목록(아이콘 + «요청됨 (vN)» + 이름 · 시각 · 반려 사유). 예전 ProofCapsule 세로 타임라인 / 가로 스트립 갈래는 하나로 합쳤다 —
  // 이력 1~2건이든 여럿이든 같은 줄 모양(2967 «빈 316px 레일» 결함은 줄 목록이라 애초에 안 생김). 같은 이름 서로 다른 사람은 [SID:4311 PR 3] «· ID 앞 8자» 꼬리 그대로(auditLabels).
  const kindIcon: Record<AuditKind, IconName> = { request: 'history', resubmit: 'history', approved: 'check_circle', rejected: 'cancel' };
  const kindTone: Record<AuditKind, string> = { request: 'text-ds-ink-3', resubmit: 'text-ds-ink-3', approved: 'text-ds-done', rejected: 'text-ds-failed' };
  return (
    <section data-testid="doc-evidence-rail" aria-label={t('docGateAuditTitle')}>
      <SectionHeader title={t('docGateAuditTitle')} level={3} />
      <ol className="m-0 list-none space-y-3 p-0 pt-3">
        {auditEvents.map((ev) => (
          <li key={ev.key} className="flex gap-2">
            <Icon name={kindIcon[ev.kind]} size={16} className={cn('mt-0.5 shrink-0', kindTone[ev.kind])} />
            <div className="min-w-0 flex-1">
              <div className="break-keep text-ds-body text-ds-ink">{`${auditKindLabel[ev.kind]}${ev.version ? ` (v${ev.version})` : ''}`}</div>
              {/* [SID:4311 PR 3] 꼬리 붙은 행 라벨(«이름 · ID 앞 8자»)은 RowName으로 — 이름만 잘리고 동명이인을 가르는 꼬리는 늘 보인다(한 덩어리 truncate 금지 · row-name 가드). */}
              <div className="flex min-w-0 items-baseline text-ds-small text-ds-ink-3">
                <RowName label={(ev.actorId ? auditLabels.get(ev.actorId) : undefined) ?? ev.name} id={ev.actorId} />
                <span className="shrink-0 whitespace-pre">{` · ${fmtDate(ev.at)}`}</span>
              </div>
              {ev.note?.trim() ? (
                <p className="mt-1 whitespace-pre-wrap break-keep border-l-2 border-ds-failed bg-ds-surface-sunk px-2 py-1 text-ds-small text-ds-ink-2 [overflow-wrap:anywhere]">{ev.note}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
