'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft, CheckCircle, XCircle } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GateEvidence, gateNeedsAction, gateDecision } from '@/components/cage/gate-evidence';
import { GateSignatureApproval } from '@/components/cage/gate-signature-approval';
import { GateUndoButton, isUndoEligible } from '@/components/cage/gate-undo-button';
import { GateDiscussDialog } from '@/components/cage/gate-discuss-dialog';
import { deriveRiskLevel, usesSignatureFlow } from '@/components/cage/gate-risk';
import { useSyntheticParentTabHistory } from '@/hooks/use-synthetic-parent-tab-history';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem } from '@/components/kanban/types';
import { fetchWithAuth } from '@/lib/db/client';
import { EntityBacklinksSection } from '@/components/shared/entity-backlinks-section';

// story #1954(P1a-S4) — Gate 3종(게이트·문서결재·머지게이트) canonical 상세. P1a·P2 공용 유일
// per-gate 라우트(중복 빌드 봉쇄) — decision(inbox_items)은 별도 표면(오르테가군 PO 판단+
// 디디군·유나양 2줄검증 확定, 2026-07-17). #1951 매니페스트 target=gate_detail·parentTab=approvals.
//
// BE 계약(story #1970, 디디군, PR#2253 — 스레드 합의 shape 그대로 구현·까심 QA 중): `GET
// /api/v2/gates/{id}` 신설 — project_id(신규, resolve_work_item_project_id 재사용)·
// work_item_summary(doc=title+slug, story/task=title만+slug=null, 그 외=null) 응답. PR#2253
// 머지+배포 전까지 이 프록시는 404를 그대로 패스스루(notFound 상태로 자연 처리).
//
// 위험도(risk) 판정+보수적 unknown 처리 정책은 gate-risk.ts 참고(deriveRiskLevel/usesSignatureFlow).
interface GateDetail extends GateItem {
  org_id: string;
  project_id?: string | null;
}

export default function GateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = useTranslations('cage');
  // 조직/프로젝트 식별(AC) — 현재 탭이 이미 로드해둔 멤버십 목록에서 이름 조회(신규 fetch 0).
  // 크로스 프로젝트 게이트(현재 탭 프로젝트가 아닌 경우)는 매칭 실패 → ID 스니펫 폴백(정직한 값).
  const { orgMemberships, projectMemberships, currentTeamMemberId } = useDashboardContext();
  // story #1959(P2-S3): 딥링크 매니페스트(gate_detail→parentTab=approvals) — 콜드 진입 시 "결재함"
  // 탭 루트를 BACK 대상으로 선주입. 결재함 목록에서 클릭해 온 경우(history.length>1)는 no-op.
  useSyntheticParentTabHistory('/inbox');

  const [gate, setGate] = useState<GateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [resolving, setResolving] = useState(false);
  // story #2043 AC3: 서버가 거부(422 등)하면 그 이유를 사람이 읽을 문구로 보여준다 — 버튼
  // disable만으로는 "왜 안 되는지"가 안 보이므로 AC 미충족.
  const [transitionError, setTransitionError] = useState<string | null>(null);
  // story #2043 AC4: 누가 결재했는지 화면에 남는다 — gate-inbox.tsx와 동일 패턴(팀 멤버 이름맵,
  // resolver_id는 BE가 인증 caller로 강제하므로 신뢰 가능).
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});

  const fetchGate = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const res = await fetchWithAuth(`/api/gates/${id}`);
      if (res.status === 404) { setNotFound(true); return; }
      if (!res.ok) return;
      const json = await res.json();
      setGate((json?.data ?? json) as GateDetail);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void fetchGate(); }, [fetchGate]);

  // story #2631 QA중 발견 — memberNames를 deps에 넣으면 setMemberNames가 매번 새 객체
  // 레퍼런스를 만들어(resolver가 응답 목록에 없는 한) 이 effect가 무한 재실행됐다(fetch
  // 폭주). resolver_id별로 한 번만 시도하도록 ref로 추적 — 기존 소비처(resolver_id 표시)와
  // 무관한 사전 버그였고 이번 undo 테스트 픽스처(status!='pending')가 처음 건드렸다.
  const fetchedResolverIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!gate?.resolver_id || fetchedResolverIdRef.current === gate.resolver_id) return;
    fetchedResolverIdRef.current = gate.resolver_id;
    void fetchWithAuth('/api/team-members')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: { id: string; name: string }[] } | null) => {
        if (!json?.data) return;
        const names: Record<string, string> = {};
        for (const m of json.data) names[m.id] = m.name;
        setMemberNames((prev) => ({ ...prev, ...names }));
      })
      .catch(() => { /* non-critical — id 스니펫 폴백으로 graceful */ });
  }, [gate?.resolver_id]);

  // gate-inbox.tsx와 동형 판정(중복 빌드 봉쇄 취지상 동일 규칙 재사용) — doc/canonicalize gate는
  // requires_human 메타가 없어(BE 구조상) gateNeedsAction()만으로는 액션 필요 여부를 못 잡는다.
  // ⚠️버그 fix(라이브 실측 중 자체 발견): status===pending 가드가 없으면 이미 approved/rejected
  // 된 게이트도 액션 UI(서명/승인 버튼)가 활성 상태로 다시 뜬다 — 결재 완료된 게이트를 재차
  // 승인 가능한 것처럼 보이는 게 실 결함이라 canonical의 첫 라이브 실측에서 바로 잡았다.
  const isDocGate = gate?.work_item_type === 'doc' || gate?.gate_type === 'doc_approval';
  const isCanonicalizeGate = gate?.gate_type === 'artifact_canonicalize';
  const needsAction = !!gate && gate.status === 'pending' && (gateNeedsAction(gate) || isDocGate || isCanonicalizeGate);
  // story #2091(P0) — needsAction은 "이 게이트가 사람의 판단을 필요로 하는가"만 답한다(gate 자체의
  // 속성). "이 화면을 보는 나(caller)에게 승인 권한이 있는가"는 별개 질문인데 여태 이 둘을 섞어서
  // needsAction=true이면 무조건 버튼을 열었다 — 오르테가군이 라이브에서 직접 재현(까심군이 잡은
  // can_approve:false ↔ 버튼 노출 불일치의 근본): 에이전트 계정이 이 화면에 들어오면 BE는
  // `POST .../transition`을 403으로 정확히 거부하는데(휴먼 전용, rule A) 화면은 버튼을 계속
  // 보여줬다 — "눌렀는데 실패"가 아니라 "내가 승인할 수 있다고 믿게 되는" 더 나쁜 형태(유나양
  // §1-1). 서버가 준 gate.can_approve(BE per-caller 판정)를 근거로만 버튼을 열고 닫는다 — 화면이
  // 독자 판정으로 서버를 덮지 않는다(AC2). needsAction=true인데 can_approve=false면(권한 없는
  // 뷰어) 아래에서 읽기전용 사유 문구로 분기한다(무권한 상태에서 액션 버튼 자체를 렌더하지 않음).
  const canAct = needsAction && gate?.can_approve === true;

  const transition = useCallback(async (status: 'approved' | 'rejected', note?: string, evidenceViewed?: boolean) => {
    if (!gate) return;
    setResolving(true);
    setTransitionError(null);
    try {
      const res = await fetchWithAuth(`/api/gates/${gate.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // story #2027 AC2: evidence_viewed는 GateSignatureApproval의 onApprove가 호출될 때만
        // 실려온다(그 컴포넌트 자체가 canSign=evidenceViewed&&reason로 버튼을 막아 이 콜백에
        // 도달했다는 사실 자체가 열람 확인 — 아래 저위험 경로는 안 보내 undefined→백엔드가
        // risk_grade=='high'가 아니면 아예 안 봄).
        body: JSON.stringify({ status, note: note?.trim() || null, evidence_viewed: evidenceViewed ?? false }),
      });
      // story #1990: push()는 콜드-진입 합성 스택([parentTab, target])에 세번째 엔트리를
      // 쌓아 브라우저 BACK 1회가 이 상세를 재진입시키는 트랩을 만든다(§3.2 재진입 트랩).
      // replace()는 현재 엔트리를 그대로 교체해 스택 길이를 늘리지 않는다 — router.back()/
      // window.history.back() 직접호출([[feedback-history-back-nextjs]] 금지) 없이 동일 효과.
      // story #2164(2026-07-25, 까심): 예전엔 '/inbox'(기본=알림 탭)로 갔다 — 방금 게이트를
      // 승인/거부한 사람은 다음 게이트를 마저 처리하러 온 것이지 알림을 보러 온 게 아니다.
      // '?tab=gates'로 명시해 실제 결재함(게이트 탭)으로 돌아간다.
      if (res.ok) {
        router.replace('/inbox?tab=gates');
        return;
      }
      // story #2043 AC3: 서버 거부(예: #2027 — 고위험 승인은 note 필수, 422)를 사람이 읽을
      // 문구로 보여준다. story #2500 — `body.detail`은 실 envelope({data,error,meta})에
      // 없는 필드라 이 분기는 항상 죽어있었다(그라운딩 확認 — BE HTTPException(detail=...)은
      // 평문 문자열이지만 handler가 error.message로 재포장한다, gates.py:885). 올바른
      // 필드로 교정 — #2027의 "고위험 승인 사유 필수" 문구가 실제로 화면에 뜨게 된다.
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      const reason = body?.error?.message ?? t('gateTransitionErrorGeneric');
      setTransitionError(reason);
    } finally {
      setResolving(false);
    }
  }, [gate, router, t]);

  // story #2631 — «보류(논의 필요)». transition()과 형제: 상태 전이가 없어(pending 유지)
  // 페이지 이동 없이 그 자리서 fetchGate()로 discussion_requested만 갱신한다.
  const [discussDialogOpen, setDiscussDialogOpen] = useState(false);
  const [discussSubmitting, setDiscussSubmitting] = useState(false);
  const [discussError, setDiscussError] = useState<string | null>(null);
  const discuss = useCallback(async (reason: string) => {
    if (!gate) return;
    setDiscussSubmitting(true);
    setDiscussError(null);
    try {
      const res = await fetchWithAuth(`/api/gates/${gate.id}/discuss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (res.ok) { await fetchGate(); setDiscussDialogOpen(false); return; }
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setDiscussError(body?.error?.message ?? t('gateTransitionErrorGeneric'));
    } catch {
      // story #2631 — PO 리뷰(PR#3068) 지적: try/finally뿐이면 네트워크 실패 시 무표시+
      // unhandled rejection. 챗 카드(approval-request-card.tsx)와 패리티.
      setDiscussError(t('gateTransitionErrorGeneric'));
    } finally {
      setDiscussSubmitting(false);
    }
  }, [gate, fetchGate, t]);

  return (
    <>
      <TopBarSlot
        title={
          <button
            type="button"
            onClick={() => router.replace('/inbox?tab=gates')}
            className="flex flex-shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('gateDetailBackToInbox')}
          </button>
        }
      />
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-5">
        {loading ? (
          <p className="text-sm text-muted-foreground">{t('gateInboxLoading')}</p>
        ) : notFound || !gate ? (
          <p className="text-sm text-muted-foreground">{t('gateDetailNotFound')}</p>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="chip">{gate.gate_type}</Badge>
                {deriveRiskLevel(gate) === 'high' ? (
                  <Badge variant="warning">{t('riskHigh')}</Badge>
                ) : deriveRiskLevel(gate) === 'unknown' ? (
                  <Badge variant="outline" className="text-muted-foreground">{t('riskUnknown')}</Badge>
                ) : null}
              </div>
              <h1 className="text-base font-semibold text-foreground">
                {gate.work_item_summary?.title ?? `#${gate.work_item_id.slice(0, 8)}`}
              </h1>
              <p className="text-xs text-muted-foreground">
                {t('gateDetailOrgContext', {
                  org: orgMemberships.find((o) => o.orgId === gate.org_id)?.orgName ?? gate.org_id.slice(0, 8),
                })}
                {gate.project_id
                  ? ` · ${projectMemberships.find((p) => p.projectId === gate.project_id)?.projectName ?? gate.project_id.slice(0, 8)}`
                  : ''}
              </p>
            </div>

            {!needsAction ? (
              <div className="space-y-3">
                <GateEvidence gate={gate} />
                {/* story #2043 AC1: status·requires_human·evidence_status 조합별 단일 문장 —
                    조합표(코드 근거):
                    - status≠pending → 이미 해소됨(무엇으로 닫혔는지)
                    - status=pending, decision=block → 자동 차단·읽기전용
                    - status=pending, decision=auto_merge(requires_human 무관, 실제 BE 판정값) → 자동 통과·액션 불필요
                    - status=pending, 그 외 전부(decision=null 또는 requires_human=false라 액션 미노출)
                      → "판정 미거침" — gateDecision()이 이미 requires_human을 반영해 null을
                      리턴하므로 여기서 "Auto-passed"를 함부로 말하지 않는다(진짜 판정 없이
                      Auto로 단정하던 게 자기모순의 절반이었다). */}
                <p className="text-[11px] text-muted-foreground">
                  {gate.status !== 'pending'
                    ? (gate.resolver_id
                        ? t('gateDetailResolvedByStatus', { name: memberNames[gate.resolver_id] ?? gate.resolver_id.slice(0, 8), status: gate.status })
                        : t('gateDetailResolvedStatus', { status: gate.status }))
                    : gateDecision(gate) === 'block' ? t('gateReadonlyBlock')
                    : gateDecision(gate) === 'auto_merge' ? t('gateReadonlyAuto')
                    : t('gateReadonlyNoVerdict')}
                </p>
                {/* story #2631 — 오클릭 정정(방금 본인이 해소한 게이트, 5분 창). */}
                {isUndoEligible(gate, currentTeamMemberId) ? (
                  <GateUndoButton gateId={gate.id} onUndone={() => void fetchGate()} />
                ) : null}
              </div>
            ) : !canAct ? (
              // story #2091(P0) — needsAction=true(게이트 자체는 사람 판단이 필요)이지만
              // gate.can_approve=false(이 caller는 승인 권한 없음, BE per-caller 판정). 액션
              // 버튼을 렌더하지 않고 왜 못 누르는지를 정직하게 알린다 — "이미 처리됨"과는
              // 다른 사유이므로 별개 문구(gateReadonlyNotAuthorized)를 쓴다.
              <div className="space-y-3">
                <GateEvidence gate={gate} />
                <p className="text-[11px] text-muted-foreground">{t('gateReadonlyNotAuthorized')}</p>
              </div>
            ) : usesSignatureFlow(deriveRiskLevel(gate)) ? (
              <GateSignatureApproval
                gate={gate}
                resolving={resolving}
                error={transitionError}
                onApprove={(reason) => void transition('approved', reason, true)}
                onReject={(reason) => void transition('rejected', reason)}
                onDiscuss={(reason) => void discuss(reason)}
              />
            ) : (
              <div className="space-y-3">
                <GateEvidence gate={gate} />
                {transitionError ? (
                  <p
                    className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-foreground"
                    role="alert"
                    aria-live="assertive"
                    aria-atomic="true"
                  >
                    {t('gateTransitionError', { reason: transitionError })}
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="min-h-12 flex-1 gap-1.5"
                    disabled={resolving}
                    onClick={() => void transition('rejected')}
                  >
                    <XCircle className="size-4" />
                    {t('gateReject')}
                  </Button>
                  <Button
                    className="min-h-12 flex-1 gap-1.5"
                    disabled={resolving}
                    onClick={() => void transition('approved')}
                  >
                    <CheckCircle className="size-4" />
                    {resolving ? '...' : t('gateApprove')}
                  </Button>
                </div>
                {/* story #2631 — 「보류(논의 필요)」. 저위험 경로엔 사유 입력창이 없어 다이얼로그로. */}
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-muted-foreground"
                  disabled={resolving}
                  onClick={() => setDiscussDialogOpen(true)}
                >
                  {t('gateDiscussSubmit')}
                </Button>
              </div>
            )}

            {/* story #2902(후보 B, S2h①③ list_entity_backlinks 확장 소비처) — 「이 게이트를
                언급한 대화」 역참조. 기성 EntityBacklinksSection(3곳 소비 중) 그대로 재사용 —
                신규 뷰어 0. gate는 TARGET_ONLY라 액션 없이 조회만(§8 계약과 정합). */}
            <EntityBacklinksSection entityType="gate" entityId={gate.id} />
          </>
        )}
      </div>
      {gate ? (
        <GateDiscussDialog
          open={discussDialogOpen}
          onOpenChange={setDiscussDialogOpen}
          onSubmit={(reason) => void discuss(reason)}
          submitting={discussSubmitting}
          error={discussError}
        />
      ) : null}
    </>
  );
}
