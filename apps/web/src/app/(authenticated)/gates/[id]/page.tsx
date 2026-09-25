'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft, CheckCircle, XCircle } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GateEvidence, GateActivityHistory, GateLinkedEvidenceSection, gateNeedsAction, gateDecision } from '@/components/cage/gate-evidence';
import { NewsletterSendStatus } from '@/components/cage/newsletter-send-status';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { ProductionWorkbenchEvidencePanel } from '@/components/cage/production-workbench-evidence';
import { LineagePerformancePanel } from '@/components/cage/lineage-performance';
import { BoostExecutionControl } from '@/components/cage/boost-execution-control';
import { GateSignatureApproval } from '@/components/cage/gate-signature-approval';
import { GateUndoButton, isUndoEligible } from '@/components/cage/gate-undo-button';
import { GateDiscussDialog } from '@/components/cage/gate-discuss-dialog';
import { deriveRiskLevel, usesSignatureFlow, deriveGateProofState, isDecisionGate, deriveDecisionFacts, reviewedDraftOf } from '@/components/cage/gate-risk';
import { buildGateTransitionBody } from '@/lib/gate-decision-payload';
import { gateTypeLabel } from '@/lib/gate-type-label';
import { recipeStageLabel } from '@/lib/recipe-stage-label';
import { stageRoleLabel } from '@/lib/stage-role';
import { gateStatusLabel } from '@/lib/gate-status-label';
import { useSyntheticParentTabHistory } from '@/hooks/use-synthetic-parent-tab-history';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem } from '@/components/kanban/types';
import { fetchWithAuth } from '@/lib/db/client';
import { fetchGateById } from '@/lib/fetch-gate';
import { EntityBacklinksSection } from '@/components/shared/entity-backlinks-section';
import { ProofCapsule } from '@/components/proof-capsule/proof-capsule';
import { useSseMultiplexerContext } from '@/components/realtime-provider';
import { gateApproveLabelKey } from '@/lib/newsletter-gate-approve-label';
import { useFlatHref } from '@/hooks/use-flat-href';
import { withProjectParam } from '@/lib/with-project-param';

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

// story #4057(E-RECIPE-1 ③, 유나 작업대 시안 v1) — GateEvidence 옆에 크리에이터 에이전트
// stage 산출물(#4041 계약)을 얹는다. work_item_type이 story/task가 아니면(doc·loop_run·
// artifact 등) 이 축 자체가 없어 안 그린다 — GateItem.work_item_type은 서버 원문 문자열이라
// 여기서 좁힌다(가짜 상태로 마운트하지 않는다).
function GateProductionWorkbenchEvidence({ gate }: { gate: GateDetail }) {
  if (gate.work_item_type !== 'story' && gate.work_item_type !== 'task') return null;
  // story #4433 qa:changes round-3(카디르+페드루, 2026-09-19) — #4423가 심은
  // gate.neutral_facts.stage denorm(recipe_gate_hooks.py 주석의 FE 계약 그대로) — evidence
  // payload.stage와 매칭해 "지금 승인 대상 stage"의 산출물만 current로 판별한다(시간축
  // 최신 추정은 새 컨셉 등록 직후 구 pass를 현재로 오도할 수 있어 폐기).
  const currentStage = typeof gate.neutral_facts?.['stage'] === 'string' ? gate.neutral_facts['stage'] : null;
  return <ProductionWorkbenchEvidencePanel workItemId={gate.work_item_id} workItemType={gate.work_item_type} currentStage={currentStage} />;
}

// story #4063(E-RECIPE-1 ④, PR #4434+#4061 위) — material_lineage는 work_item_id 축 하나로만
// 조회되므로(story/task 구분 불요, material_lineage.py 라우터 참고) 위 형제와 달리
// work_item_type 가드가 없다 — 대신 이 스토리가 애초에 story 종류(레시피 apply)일 때만
// row가 존재하므로 패널 자체가 omit-when-empty로 자연 필터링한다.
function GateLineagePerformance({ gate }: { gate: GateDetail }) {
  if (gate.work_item_type !== 'story' && gate.work_item_type !== 'task') return null;
  return <LineagePerformancePanel workItemId={gate.work_item_id} />;
}

export default function GateDetailPage() {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = useTranslations('cage');
  // story #3565 — ccGateType*/ccGateGeneric 키는 'dashboard' 네임스페이스에 산다
  // (공용 헬퍼로 옮긴 것은 로직뿐, 키 위치는 그대로) — 이 화면 자체 t는 'cage'.
  const tDashboard = useTranslations('dashboard');
  // story #4082(유나 design CHANGES 2026-09-21) — approvals-queue.tsx·recipe-detail-view.tsx
  // 와 동일 SSOT(organization 네임스페이스)로 stage/role 낱말을 통일.
  const tOrg = useTranslations('organization');
  // 조직/프로젝트 식별(AC) — 현재 탭이 이미 로드해둔 멤버십 목록에서 이름 조회(신규 fetch 0).
  // 크로스 프로젝트 게이트(현재 탭 프로젝트가 아닌 경우)는 매칭 실패 → ID 스니펫 폴백(정직한 값).
  const { orgMemberships, projectMemberships, currentTeamMemberId, orgTimezone } = useDashboardContext();
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
  // story #3113(실사고·선생님 2026-08-26) — 결정 게이트(agent_decision_request)의 승인 전
  // 안 선택(approvals-queue.tsx의 원탭 인라인 카드와 동일 계약: 선택안이 note에 실려
  // resolution_note로 영구 기록된다, AC3).
  const [selectedOption, setSelectedOption] = useState<string | null>(null);

  // story #4027(유나 전수→PO 코드 확認) — 실시간 구독(아래 mux.subscribe 2곳)이 부르는 재조회는
  // `silent: true`로 넘겨 `loading`을 켜지 않는다. 이전엔 매번 setLoading(true)를 태워, 다른
  // 승인자가 같은 게이트를 먼저 해소·위임하는 순간 이 화면 전체가 «불러오는 중» 한 줄로
  // 무너졌다 복구됐다(ProofCapsule 서브트리 통째 언마운트→리마운트라 입력 중이던 결정
  // 메모·선택안도 함께 날아감, AC2). 형제 `approval-request-card.tsx`는 애초 fetchGate가
  // loading state 자체를 안 건드리는 구조(초기값만 loading)라 이 결함이 없었다 — 그 패턴을
  // 그대로 가져와 최소 변경: 성공하면 화면 교체·실패(404 제외)하면 기존 화면 유지, 첫
  // 로드·id 변경 때만(호출부가 silent 생략) «불러오는 중».
  // story #4266(까디르 codex 4634 P2) — 새 상태를 화면에 반영했는지 돌려준다(뉴스레터 발송 재시도 뒤 «다시 불러왔어요»를 말해도 되는지).
  // 실패하면 이전 게이트를 그대로 둔다(예전과 같음). 404는 «없어짐»을 반영한 것이라 true.
  // story #4290 — 방금 다시 읽은 게이트(상태 반영 전 값을 onRetried가 읽는다).
  const latestGateRef = useRef<GateItem | null>(null);
  const fetchGate = useCallback(async (opts?: { silent?: boolean }): Promise<boolean> => {
    if (!opts?.silent) setLoading(true);
    try {
      // story #4253 — 공용 fetchGateById(날 GateResponse 한 모양) · story #4266 — 반영 여부를 돌려준다(404 = «없어짐» 반영 = true).
      const result = await fetchGateById<GateDetail>(id);
      if (result.kind === 'not-found') { setNotFound(true); return true; }
      if (result.kind !== 'ok') return false;
      setGate(result.gate);
      latestGateRef.current = result.gate;
      setNotFound(false);
      return true;
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [id]);

  useEffect(() => { void fetchGate(); }, [fetchGate]);

  // story #2985 AC2(PO 계약 확定 2026-08-24) — 다른 승인자가 이 게이트를 먼저 해소하거나
  // 위임하면, 이 상세 페이지를 보고 있는 화면도 새로고침 없이 갱신된다. approval-request-
  // card.tsx(챗 카드)와 완전히 동형 구독 — BE 계약(notify_gate_card_recipients_resolved/
  // notify_gate_delegated_to_old_approver)은 이미 존재(신규 배관 0), 여기가 빠져 있던 두
  // FE 표면 중 하나. mux가 없으면(RealtimeProvider 밖) 조용히 스킵 — 기존처럼 마운트 1회
  // fetchGate만 유효(회귀 아님, 저하일 뿐).
  const mux = useSseMultiplexerContext();
  useEffect(() => {
    if (!mux) return;
    const unsub = mux.subscribe('conversation.gate_resolved', (raw) => {
      try {
        const payload = JSON.parse(raw) as { gate_id?: string };
        if (payload.gate_id === id) void fetchGate({ silent: true });
      } catch { /* malformed — 무시(다음 정상 이벤트나 fetchGate 재시도로 자연 회복) */ }
    });
    return unsub;
  }, [mux, id, fetchGate]);

  useEffect(() => {
    if (!mux) return;
    const unsub = mux.subscribe('conversation.gate_delegated', (raw) => {
      try {
        const payload = JSON.parse(raw) as { gate_id?: string };
        if (payload.gate_id === id) void fetchGate({ silent: true });
      } catch { /* malformed — 무시 */ }
    });
    return unsub;
  }, [mux, id, fetchGate]);

  // story #2631 QA중 발견 — memberNames를 deps에 넣으면 setMemberNames가 매번 새 객체
  // 레퍼런스를 만들어(resolver가 응답 목록에 없는 한) 이 effect가 무한 재실행됐다(fetch
  // 폭주). resolver_id별로 한 번만 시도하도록 ref로 추적 — 기존 소비처(resolver_id 표시)와
  // 무관한 사전 버그였고 이번 undo 테스트 픽스처(status!='pending')가 처음 건드렸다.
  // story #4136 — designated_approver_id도 같은 캐시에 태운다(비결재자 뷰의 «결재는
  // {이름}에게 배정돼 있어요» 표기). BE에 새 name 필드를 요청할 필요가 없다 — /api/team-
  // members가 이미 전 멤버 이름을 주므로(지어내지 않음, 실 조회) 이 훅만 두 id를 같이
  // 추적하면 된다. 두 id를 합친 키로 "이미 이 조합을 시도했는지" 판별(둘 중 하나만 바뀌어도
  // 재시도).
  const fetchedNamesKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${gate?.resolver_id ?? ''}|${gate?.designated_approver_id ?? ''}`;
    if (key === '|' || fetchedNamesKeyRef.current === key) return;
    fetchedNamesKeyRef.current = key;
    void fetchWithAuth('/api/team-members')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: { id: string; name: string }[] } | null) => {
        if (!json?.data) return;
        const names: Record<string, string> = {};
        for (const m of json.data) names[m.id] = m.name;
        setMemberNames((prev) => ({ ...prev, ...names }));
      })
      .catch(() => { /* non-critical — id 스니펫 폴백으로 graceful */ });
  }, [gate?.resolver_id, gate?.designated_approver_id]);

  // gate-inbox.tsx와 동형 판정(중복 빌드 봉쇄 취지상 동일 규칙 재사용) — doc/canonicalize gate는
  // requires_human 메타가 없어(BE 구조상) gateNeedsAction()만으로는 액션 필요 여부를 못 잡는다.
  // ⚠️버그 fix(라이브 실측 중 자체 발견): status===pending 가드가 없으면 이미 approved/rejected
  // 된 게이트도 액션 UI(서명/승인 버튼)가 활성 상태로 다시 뜬다 — 결재 완료된 게이트를 재차
  // 승인 가능한 것처럼 보이는 게 실 결함이라 canonical의 첫 라이브 실측에서 바로 잡았다.
  const isDocGate = gate?.work_item_type === 'doc' || gate?.gate_type === 'doc_approval';
  const isCanonicalizeGate = gate?.gate_type === 'artifact_canonicalize';
  // story #3134(#3128 전수점검 잔여 — loop_decision) — HypothesisOutcomeDraft(gate-evidence.tsx)가
  // 초안 verdict(verified/falsified/killed·actual·reason) 텍스트는 보여주지만, 그 판정이 어느
  // loop을 재는지로 가는 링크가 없었다. loop_decision의 work_item_id는 `LoopRun.id`(BE
  // loop.py:303 create_gate 호출·work_item_type='loop')다 — `/loops/{id}` 가 실 상세 페이지
  // (loop-detail-client.tsx, 268줄 실 콘텐츠 확認)라 artifact와 동일 primitive로 닫는다.
  // ⛔workflow_config_publish는 이번에도 스코프 밖 — 그라운딩 결과 `wf_line_version`은 FE
  // entity 계열에 아예 등록 안 됨(embed-card.tsx 자체 주석: RICH_PREVIEW_TYPES·ENTITY_API·
  // getEntityHref 셋 다 없음) + 대상 페이지(organization/workforce/workflow)가 "지금 사는
  // config"만 보여줄 뿐 "이 버전(review 대상)"을 볼 방법이 아예 없다 — 링크를 억지로 달면
  // #2118 P2.2 AC④가 이미 금지한 "미리보기 없는 타입에 빈 모달 여는 거짓 진입점"이 된다.
  // 이건 BE(neutral_facts에 config diff 임베드) 또는 신규 FE 뷰어가 필요한 더 큰 스코프 —
  // 페드루군에 사이징 보고.
  const isLoopDecisionGate = gate?.gate_type === 'loop_decision';
  // story #3813(Phase3·3-4 PR4, 페드루 PO 確定+CHANGES 2026-09-12) — 판별 로직은
  // newsletter-gate-approve-label.ts 한 곳에만(gate-signature-approval.tsx·
  // approvals-queue.tsx도 같은 헬퍼를 쓴다 — 처음엔 이 평문 버튼에만 붙여 정작
  // 고위험 게이트가 타는 서명 버튼엔 안 붙는 결함이 났다, CHANGES 실측).
  const approveButtonLabelKey = gateApproveLabelKey(gate);
  // story #4231 4차 B(PO 08:48Z) — 게이트 상세는 조직 수준 화면이라 bare `/gates/{id}`로 들어오면 현재 p = 쿠키 프로젝트다. 대상 링크는 현재 p가
  // 아니라 **게이트 자기 프로젝트**(GET /gates/{id}의 project_id — 4241 · 4600 해소)를 싣는다. 모르면(조직 단위 게이트) 주소 그대로.
  const gateProjectId = gate?.project_id ?? null;
  const targetLink = isDocGate && gate?.work_item_summary?.slug
    ? { href: withProjectParam(`/docs/${gate.work_item_summary.slug}`, gateProjectId), labelKey: 'gateDetailViewTargetDoc' as const }
    : isCanonicalizeGate && gate?.work_item_id
    ? { href: withProjectParam(`/artifacts/${gate.work_item_id}`, gateProjectId), labelKey: 'gateDetailViewTargetArtifact' as const }
    : isLoopDecisionGate && gate?.work_item_id
    ? { href: withProjectParam(`/loops/${gate.work_item_id}`, gateProjectId), labelKey: 'gateDetailViewTargetLoop' as const }
    : null;
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
  // story #4139([E-RECIPE-1] Phase3 폴리시, 페드루 PO 確定 2026-09-22) — deferred_to_
  // gate_id가 있으면(레시피 게이트가 대신 결재) can_approve=true여도 액션 버튼을 숨긴다.
  // 직접 transition 호출 자체를 막는 건 아니다(BE는 멱등 — 훅B가 이미 승계했으면 no-op,
  // 아직이면 정상 승인/반려되고 레시피 게이트 쪽이 나중에 캐스케이드 때 이미-결정된 걸
  // 보고 스킵) — 이 화면이 그 액션을 "권하지" 않을 뿐이다.
  const canAct = needsAction && gate?.can_approve === true && !gate?.deferred_to_gate_id;
  // story #4121(E-RECIPE-1 Phase 3 폴리시, 유나 #4056 v2 제안·PO 확定 2026-09-21) — 2열+sticky
  // 승인 패널은 우 열에 «액션»(GateSignatureApproval 또는 평문 승인/거부 버튼)이 실제로 있을
  // 때만 의미가 있다. needsAction&&canAct(아래 4갈래 분기의 c·d 갈래)만 참 — a(이미 해소)·
  // b(무권한)는 우 열이 빌 것이라 단일열 그대로 둔다(PO 지시 "우 열이 빌 때는 단일열").
  const showActionColumn = !!gate && needsAction && canAct;
  // story #3113 — question 없으면(BE 미배선 예외 등) null → 기존 title/해시 폴백으로 자연 후퇴.
  const decisionFacts = gate && isDecisionGate(gate) ? deriveDecisionFacts(gate) : null;
  const requiresOptionChoice = decisionFacts !== null && decisionFacts.options.length > 0;
  const isSigFlowGate = !!gate && usesSignatureFlow(deriveRiskLevel(gate));
  // story #3334 — 저위험 게이트의 반려(변경 요청)는 예전엔 사유 입력창 자체가 없는 인라인
  // 버튼이라 클릭 즉시 빈 사유로 제출됐다(선생님 4바퀴 T1' 실사고 재현 그 자체). 근거열람
  // 없이도 반려 자체는 가능해야 하므로(승인만 evidence 축) 저위험 게이트를 통째로 서명
  // 플로우로 밀어넣지 않고, "반려하려는 의도"일 때만 이 토글로 같은 GateSignatureApproval
  // 패널을 연다 — 승인은 기존처럼 원탭 그대로(이 스토리는 반려 축만 다룬다).
  const [rejectPanelOpen, setRejectPanelOpen] = useState(false);
  useEffect(() => { setRejectPanelOpen(false); }, [gate?.id]);

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
        // story #2975(PO 설계 확定 2026-08-24): reviewed_head_sha — 지금 이 화면이 보여주는
        // gate.github_check_run_sha를 「내가 review한 SHA」로 실어 보낸다. merge 게이트가 아니면
        // BE가 무시(SHA 개념 자체가 없는 gate_type)하므로 gate_type 분기 없이 항상 보낸다.
        // story #4190(PO 판정 2026-09-23) — 레시피 발행 게이트면 이 화면의 초안 카드가 그린 (draft_id, version)을 싣는다
        // (reviewedDraftOf — 카드가 없으면 키 자체를 안 싣는다). 그 사이 새 버전이면 BE가 409 gate_draft_changed.
        body: JSON.stringify(buildGateTransitionBody({
          status, note, evidenceViewed,
          reviewedHeadSha: gate.github_check_run_sha ?? null,
          reviewedDraft: reviewedDraftOf(gate),
        })),
      });
      // story #1990: push()는 콜드-진입 합성 스택([parentTab, target])에 세번째 엔트리를
      // 쌓아 브라우저 BACK 1회가 이 상세를 재진입시키는 트랩을 만든다(§3.2 재진입 트랩).
      // replace()는 현재 엔트리를 그대로 교체해 스택 길이를 늘리지 않는다 — router.back()/
      // window.history.back() 직접호출([[feedback-history-back-nextjs]] 금지) 없이 동일 효과.
      // story #2164(2026-07-25, 까심): 예전엔 '/inbox'(기본=알림 탭)로 갔다 — 방금 게이트를
      // 승인/거부한 사람은 다음 게이트를 마저 처리하러 온 것이지 알림을 보러 온 게 아니다.
      // '?tab=gates'로 명시해 실제 결재함(게이트 탭)으로 돌아간다.
      if (res.ok) {
        router.replace(flatHref('/inbox?tab=gates'));
        return;
      }
      // story #2043 AC3: 서버 거부(예: #2027 — 고위험 승인은 note 필수, 422)를 사람이 읽을
      // 문구로 보여준다. story #2500 — `body.detail`은 실 envelope({data,error,meta})에
      // 없는 필드라 이 분기는 항상 죽어있었다(그라운딩 확認 — BE HTTPException(detail=...)은
      // 평문 문자열이지만 handler가 error.message로 재포장한다, gates.py:885). 올바른
      // 필드로 교정 — #2027의 "고위험 승인 사유 필수" 문구가 실제로 화면에 뜨게 된다.
      const body = await res.json().catch(() => null) as { error?: { message?: string; code?: string } } | null;
      // story #2975(페드루 PO 비차단 관찰)·#2982(선생님 실사용 리포트, PO 확定 2026-08-24) —
      // BE의 code 부착 거부(gate_head_changed·gate_already_resolved)는 한국어 평문이라
      // i18n 안 됨. FE가 이미 code를 파싱하므로 code→i18n 매핑으로 렌더(영어 로케일에서도
      // 정상 표시). 그 외 code는 기존대로 BE message 그대로 통과.
      const code = body?.error?.code;
      const reason = code === 'gate_head_changed' ? t('gateHeadChangedError')
        : code === 'gate_draft_changed' ? t('gateDraftChangedError')
        : code === 'gate_already_resolved' ? t('gateAlreadyResolvedError')
        : (body?.error?.message ?? t('gateTransitionErrorGeneric'));
      setTransitionError(reason);
      // story #2975(PO 요구 ③)·#2982(AC1·AC3, 죽은 버튼 클릭~서버 응답 사이 레이스로 다른
      // 채널이 먼저 해소한 경우) — 둘 다 "화면이 보여준 상태가 서버와 어긋났다"는 뜻의
      // 거부다. 화면을 그대로 두면 사람이 옛 상태를 보며 같은 버튼을 다시 눌러 똑같이
      // 거부당한다 — 최신 상태로 재조회해 실제 현재 상태(resolved 카드 등)로 재렌더되게
      // 한다(gates/[id]/page.tsx의 needsAction 분기가 이미 status!=='pending'을 올바르게
      // 읽지 못하는 액션-숨김 표시로 처리하므로, 재조회만 하면 AC1이 자동으로 성립한다).
      // story #4190(유나) — gate_draft_changed도 같은 부류: 재조회하면 같은 화면의 초안 카드가 최신 버전으로 바뀐다(버튼 없음).
      if (code === 'gate_head_changed' || code === 'gate_draft_changed' || code === 'gate_already_resolved') {
        void fetchGate();
      }
    } finally {
      setResolving(false);
    }
  }, [gate, router, t, fetchGate, flatHref]);

  // story #2631 — «보류(논의 필요)». transition()과 형제: 상태 전이가 없어(pending 유지)
  // 페이지 이동 없이 그 자리서 fetchGate()로 discussion_requested만 갱신한다.
  const [discussDialogOpen, setDiscussDialogOpen] = useState(false);
  const [discussSubmitting, setDiscussSubmitting] = useState(false);
  const [discussError, setDiscussError] = useState<string | null>(null);
  // story #3806(Phase3·3-2 PR 12, 페드루 PO 실측 캡처 2026-09-11 18:16Z) —
  // BoostExecutionControl(형제)의 「광고비 다시 수집」 성공을 GateActivityHistory
  // (형제)가 스스로 알 방법이 없어 이 숫자를 부모가 다리 놓는다 — 증가할 때마다
  // GateActivityHistory가 재조회(그 컴포넌트의 refreshKey prop 참고).
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
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
            onClick={() => router.replace(flatHref('/inbox?tab=gates'))}
            className="flex flex-shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('gateDetailBackToInbox')}
          </button>
        }
      />
      {/* story #4121 — 컨테이너 폭은 우 열(sticky 승인 패널)이 실제로 그려질 때만 lg:에서
          max-w-6xl로 넓어진다(2열 grid가 필요로 하는 여백). <lg 및 우 열 없는 상태는 기존
          max-w-2xl 그대로(회귀 0 — 유나 시안 §2 "≤1024는 현 순서·폭 그대로").
          ⚠️정정(페드루 PO CHANGES-1, 2026-09-21 18:14Z) — 2열 grid는 ProofCapsule
          «밖»(페이지 레벨)이어야 한다. ProofCapsule의 셸(CutCornerShell, proof-capsule.tsx:152)
          은 story #2978 사유로 overflow-hidden이 의도된 값인데, CSS 스펙상 position:sticky의
          스크롤 컨테이너는 «overflow≠visible인 가장 가까운 조상»이라 grid를 그 footer 안에
          두면 우 열이 캡슐 박스 기준으로만 붙고 실제 페이지 스크롤(dashboard-shell
          overflow-y-auto)엔 안 반응한다(jsdom 클래스 단언으론 못 잡히고 dev-app 실측에서만
          보임). grid를 이 컨테이너로 끌어올려 ProofCapsule과 액션 카드를 형제로 둔다. */}
      <div
        data-testid="gate-detail-container"
        className={`mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-5 ${showActionColumn ? 'lg:max-w-6xl lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6' : ''}`}
      >
        {loading ? (
          <p className="text-sm text-muted-foreground">{t('gateInboxLoading')}</p>
        ) : notFound || !gate ? (
          <p className="text-sm text-muted-foreground">{t('gateDetailNotFound')}</p>
        ) : (
          // story #2926(P0-F F2, 잔여 fast-follow로 갱신) — 셸만 ProofCapsule density="full"로
          // 교체, 내부 로직(4갈래 상태 분기·서명 플로우·GateEvidence·EntityBacklinksSection)
          // 100% 무변경. GateRow(full 밀도 내장)는 단일 버튼 추상이라 이 페이지의 다상태 액션
          // 분기를 못 담아 — gate/human 프롭은 안 주고(GateRow 자체를 비활성) 전부 footer로
          // 이관했다. proofState/stateLabel은 gate-risk.ts의 deriveGateProofState()로 F1/F3와
          // 공유(카디르 F2 QA LOW①·② 처방 — 3곳 중복 로직 단일화+문구 통일).
          //
          // story #4121(2열+sticky, 유나 #4056 v2·PO 확定 2026-09-21) — 아래 IIFE는 footer
          // JSX를 두 배치(showActionColumn true/false)에서 재사용할 지역 상수(gateMetaFacts·
          // evidencePanels·resolvedStatusExtra·unauthorizedExtra·signatureBlock·
          // plainActionExtra·asideExtras)를 return 전에 선언하기 위한 스코프일 뿐 — 로직·
          // 컴포넌트 내부는 100% 무변경(diff 경계 = 레이아웃 유틸만).
          (() => {
            const gateMetaFacts = (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  {/* story #2937(PR#3372, 2026-08-22)로 chip variant 기본 자체가
                      text-foreground로 이행 — PR#3367의 이 지점 className 오버라이드는
                      이제 중복. 클래스가 닫혔으니 지점 처방을 걷는다(PO 지시). */}
                  {/* story #3565(유나 §17-24 전수, 페드루 PO 確定 2026-09-06) — 원시값
                      대신 사람 낱말(미등재는 일반 「게이트」). */}
                  <Badge variant="chip">{gateTypeLabel(tDashboard, gate.gate_type)}</Badge>
                  {/* story #3813(Phase3·3-4 PR4, 페드루 PO CHANGES 2026-09-12, 라이브
                      캡처 실측) — 이 상세 페이지엔 reapproval_required=true를 알리는
                      표시가 어디에도 없었다(ads_boost 선례도 실측 결과 이 페이지엔
                      없음 — inbox 카드(approvals-queue.tsx)에만 있었다, 실측으로
                      정정). 게이트 종류 무관 공용 칩 하나로 처방. */}
                  {gate.reapproval_required ? (
                    <Badge variant="warning">{t('gateReapprovalRequiredChip')}</Badge>
                  ) : null}
                </div>
                {decisionFacts ? (
                  <p className="text-xs text-muted-foreground">#{gate.work_item_id.slice(0, 8)}</p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {t('gateDetailOrgContext', {
                    org: orgMemberships.find((o) => o.orgId === gate.org_id)?.orgName ?? gate.org_id.slice(0, 8),
                  })}
                  {gate.project_id
                    ? ` · ${projectMemberships.find((p) => p.projectId === gate.project_id)?.projectName ?? gate.project_id.slice(0, 8)}`
                    : ''}
                </p>
                {/* story #4082([E-RECIPE-1] 진행 위치 표시) AC2 — approvals-queue.tsx 카드와
                    동일 관례(neutral_facts.stage(+stage_role) denorm, 레시피 게이트가 아니면
                    무변). 유나 design CHANGES — raw slug 대신 recipe-stage-label.ts/
                    stage-role.ts SSOT.
                    story #4091(유나 design 라이브 관찰, PO 확定 2026-09-21) — 이 meta 줄과
                    GateEvidence의 RecipeApprovalFactsBlock(사실 블록, gate-evidence.tsx)이
                    같은 neutral_facts.stage를 각자 렌더해 화면에 «단계»가 두 번 떴다.
                    ⚠️정정(PO 재확定, 3회째 라이브 재측정 2026-09-21) — 최초 처방은 «서명
                    플로우 분기(isSigFlowGate||rejectPanelOpen)엔 GateEvidence가 없다»고
                    가정했으나, isSigFlowGate는 gate risk level만 보는 정적 값(라인 212)이라
                    이미 승인된 게이트에도 그대로 true다. 그런 게이트는 needsAction=false라
                    첫 갈래(!needsAction)로 빠져 GateEvidence가 뜨는데, meta 줄 조건은
                    isSigFlowGate만 봐서 같이 떴다(451b5813 실측 — 이미 approved인
                    external_publish 게이트에서 meta+facts 동시 노출). 처방 — 4갈래 분기가
                    실제로 GateSignatureApproval(증거 없음)로 가는 조건 그대로
                    (needsAction && canAct && (isSigFlowGate||rejectPanelOpen))로 좁힌다 —
                    "facts 블록이 안 뜰 때만" meta 유지, 서명 플로우 여부 자체는 무관.*/}
                {typeof gate.neutral_facts?.stage === 'string' && needsAction && canAct && (isSigFlowGate || rejectPanelOpen) ? (
                  <p className="text-xs text-muted-foreground">
                    {t('gateStageLabel')}: {recipeStageLabel(gate.neutral_facts.stage, tOrg)}
                    {typeof gate.neutral_facts.stage_role === 'string' ? ` (${stageRoleLabel(gate.neutral_facts.stage_role, tOrg)})` : ''}
                  </p>
                ) : null}

                {/* story #3128 — needsAction/canAct와 무관하게 항상 렌더(이미 해소된 카드도
                    "무엇을 승인했는지" 원문을 감사할 수 있어야 한다 — decisionFacts·
                    GateActivityHistory와 같은 원칙). */}
                {targetLink ? (
                  <Link href={targetLink.href} className="text-xs font-medium text-primary hover:underline">
                    {t(targetLink.labelKey)}
                  </Link>
                ) : null}

                {/* story #3113(AC2) — 「카드를 눌러도 내용을 볼 수 있는 상세 뷰 자체가 없다」
                    처방. needsAction/canAct와 무관하게 항상 렌더(이미 해소된 결정도 «무엇을
                    물었고 무슨 전제였는지»는 감사 가치가 있다 — GateActivityHistory와 같은
                    원칙, 위 §2975 AC4 주석 참조). */}
                {decisionFacts ? (
                  <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-sm whitespace-pre-wrap text-foreground">{decisionFacts.question}</p>
                    {decisionFacts.assumption ? (
                      <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                        <span className="font-medium text-foreground">{t('decisionAssumptionLabel')}</span> {decisionFacts.assumption}
                      </p>
                    ) : null}
                    {decisionFacts.options.length > 0 ? (
                      <div className="space-y-1 pt-1">
                        <p className="text-xs font-medium text-foreground">{t('decisionOptionsLabel')}</p>
                        {decisionFacts.options.map((option) =>
                          canAct && !isSigFlowGate ? (
                            <label
                              key={option}
                              className="flex cursor-pointer items-start gap-1.5 rounded-md p-1 text-xs text-foreground hover:bg-muted/40"
                            >
                              <input
                                type="radio"
                                name="decision-option"
                                className="mt-0.5"
                                checked={selectedOption === option}
                                onChange={() => setSelectedOption(option)}
                              />
                              <span>{option}</span>
                            </label>
                          ) : (
                            <p key={option} className="text-xs text-muted-foreground">{option}</p>
                          ),
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            );

            const evidencePanels = (
              <>
                <GateEvidence gate={gate} />
                {/* story #4262(유나 표) — 발송 게이트면 뉴스레터 사실 칸 바로 아래 «발송 상태» 한 줄 + 사람 재시도. */}
                <NewsletterSendStatus
                  gate={gate} orgId={gate.org_id ?? null}
                  displayTimezone={resolveDisplayTimezone(orgTimezone).tz}
                  // story #4290 — 다시 읽은 발송 명령의 서버 판정을 돌려줘 404 뒤 결과 줄을 고른다.
                  onRetried={async () => {
                    const ok = await fetchGate({ silent: true });
                    if (!ok) return false;
                    return { retryable: latestGateRef.current?.newsletter_send_command?.command_retryable === true };
                  }}
                />
                {/* story #4136 — canAct/needsAction과 무관하게 항상 렌더(모든 열람자, AC1).
                    GateProductionWorkbenchEvidence(아래, #4057)는 work-item 범위 훅이 0건이면
                    조용히 null을 반환하는 게 원래 설계라 그대로 둔다 — 이 섹션이 게이트
                    자신의 linked_evidence[]/draft_doc_reference_token을 직접 렌더해 "제작
                    산출물 칸이 아예 안 보인다"는 실사고를 항상 뭔가(칩 또는 명시적 빈 문구)로
                    막는다. */}
                <GateLinkedEvidenceSection gate={gate} />
                <GateProductionWorkbenchEvidence gate={gate} />
                <GateLineagePerformance gate={gate} />
              </>
            );

            // story #2043 AC1: status·requires_human·evidence_status 조합별 단일 문장 —
            // 조합표(코드 근거):
            // - status≠pending → 이미 해소됨(무엇으로 닫혔는지)
            // - status=pending, decision=block → 자동 차단·읽기전용
            // - status=pending, decision=auto_merge(requires_human 무관, 실제 BE 판정값) → 자동 통과·액션 불필요
            // - status=pending, 그 외 전부(decision=null 또는 requires_human=false라 액션 미노출)
            //   → "판정 미거침" — gateDecision()이 이미 requires_human을 반영해 null을
            //   리턴하므로 여기서 "Auto-passed"를 함부로 말하지 않는다(진짜 판정 없이
            //   Auto로 단정하던 게 자기모순의 절반이었다).
            const resolvedStatusExtra = (
              <>
                <p className="text-[11px] text-muted-foreground">
                  {gate.status !== 'pending'
                    ? (gate.resolver_id && memberNames[gate.resolver_id]
                        // story #3806 PR 9(페드루 PO 리뷰 2026-09-11 실측) — 이름을 아직
                        // 모르면(비동기 조회 경합·조직 밖 등) id 스니펫을 날것으로 보여주던
                        // 자리를 없앴다 — 이름을 확실히 알 때만 「{name}님이 처리」, 모르면
                        // 그냥 「이미 처리됨」(gateDetailResolvedStatus)으로 조용히 물러난다
                        // (raw id 노출 경로 자체를 제거 — 타이밍이든 진짜 미스든 둘 다 막힘).
                        ? t('gateDetailResolvedByStatus', { name: memberNames[gate.resolver_id], status: gateStatusLabel(gate.status, t) })
                        : t('gateDetailResolvedStatus', { status: gateStatusLabel(gate.status, t) }))
                    : gateDecision(gate) === 'block' ? t('gateReadonlyBlock')
                    : gateDecision(gate) === 'auto_merge' ? t('gateReadonlyAuto')
                    : t('gateReadonlyNoVerdict')}
                </p>
                {/* story #2631 — 오클릭 정정(방금 본인이 해소한 게이트, 5분 창). */}
                {isUndoEligible(gate, currentTeamMemberId) ? (
                  <GateUndoButton gateId={gate.id} onUndone={() => void fetchGate()} />
                ) : null}
              </>
            );

            // story #2091(P0) — needsAction=true(게이트 자체는 사람 판단이 필요)이지만
            // gate.can_approve=false(이 caller는 승인 권한 없음, BE per-caller 판정). 액션
            // 버튼을 렌더하지 않고 왜 못 누르는지를 정직하게 알린다 — "이미 처리됨"과는
            // 다른 사유이므로 별개 문구(gateReadonlyNotAuthorized)를 쓴다.
            //
            // story #3006(유나 design 관찰, 페드루 확定 2026-08-24) — #3001 카드배타화
            // 이후 이 표면(gate 상세, 직접 URL/감사 진입)이 「무권한」과 「지정 결재선이
            // 걸려 있음」을 같은 문구로 뭉뚱그리던 유일한 실 표적(챗카드는 비지정자에게
            // 애초 안 감 — approval-request-card.tsx 주석 참조).
            // ⚠️정정(story #4136, 2026-09-22) — "이름은 안 싣는다"는 그때 BE가 이름을
            // 안 줬기 때문이었지 원칙 자체가 아니었다. designated_approver_id는 이미
            // memberNames 캐시(위 effect, #4136에서 이 id도 같이 추적하도록 확장)로 실 이름을
            // 조회할 수 있다(지어내지 않음, /api/team-members 실 조회) — 이름을 아는
            // 경우에만 named 문구, 모르면(응답 지연·조회 실패) 기존 무명 문구로 graceful
            // 폴백한다(resolvedStatusExtra의 gateDetailResolvedByStatus/gateDetailResolvedStatus
            // 폴백과 동형 패턴).
            const unauthorizedExtra = (
              <p className="text-[11px] text-muted-foreground">
                {gate.designated_approver_id && gate.designated_approver_id !== currentTeamMemberId
                  ? (memberNames[gate.designated_approver_id]
                      ? t('gateReadonlyDesignatedElsewhereNamed', { name: memberNames[gate.designated_approver_id] })
                      : t('gateReadonlyDesignatedElsewhere'))
                  : t('gateReadonlyNotAuthorized')}
              </p>
            );

            // story #4139 — deferred_to_gate_id가 있으면(레시피 게이트가 대신 결재) 무권한
            // 문구(unauthorizedExtra) 대신 이 문구 + 링크. can_approve 값과 무관 — "내가 못
            // 누른다"가 아니라 "이 게이트는 다른 게이트가 대신 결정한다"는 별개 사실이라
            // 문구도 별개(unauthorizedExtra와 절대 안 섞는다).
            const deferredExtra = gate.deferred_to_gate_id ? (
              <p className="text-[11px] text-muted-foreground">
                {t('gateDeferredToRecipeGate')}
                {' · '}
                <Link href={flatHref(`/gates/${gate.deferred_to_gate_id}`)} className="font-medium text-primary hover:underline">
                  {t('gateDeferredToRecipeGateLink')}
                </Link>
              </p>
            ) : null;

            // story #2975(유나양 design 판정 2026-08-24, PO 확定) — 409(gate_head_changed)
            // 후 fetchGate() 재조회로 gate.github_check_run_sha가 바뀌어도, key 없이는 이
            // 컴포넌트가 그대로 살아있어 evidenceViewed/reason state가 안 리셋된다 —
            // canSign이 true로 유지된 채 새 SHA(B)로 자동 재승인 가능(PO가 B를 실제로
            // 다시 안 봄) = 서버가 막은 "리뷰 안 한 SHA 승인"이 UX 층에서 그대로 뚫림.
            // key={SHA}로 SHA가 바뀔 때마다 강제 remount — 세밀한 useEffect 리셋 목록은
            // 미래 state 추가마다 리셋 누락 사각을 만드는 구조(이번 사고와 동형 클래스)라
            // PO가 명시 기각, remount가 미래 state까지 구조적으로 안전(최소안 채택).
            const signatureBlock = (
              <div className="space-y-2">
                <GateSignatureApproval
                  // story #4190 — 초안 버전이 바뀌어도(409 gate_draft_changed 뒤 재조회) 같은 리셋.
                  key={`${gate.github_check_run_sha ?? ''}:${reviewedDraftOf(gate)?.version ?? ''}`}
                  gate={gate}
                  resolving={resolving}
                  error={transitionError}
                  onApprove={(reason) => void transition('approved', reason, true)}
                  onReject={(reason) => void transition('rejected', reason)}
                  onDiscuss={(reason) => void discuss(reason)}
                />
                {/* story #3334 — 저위험 게이트는 «변경 요청» 클릭으로만 이 패널에 들어온다
                    (원래 근거열람+사유 요구가 없는 등급) — 잘못 눌렀을 때 원탭 승인 화면으로
                    되돌아갈 길을 남긴다. 고위험(isSigFlowGate) 게이트는 이 패널이 유일한
                    경로라 취소 버튼 자체가 무의미(숨김).*/}
                {!isSigFlowGate ? (
                  <Button type="button" variant="ghost" size="sm" className="w-full text-muted-foreground" disabled={resolving} onClick={() => setRejectPanelOpen(false)}>
                    {t('cancel')}
                  </Button>
                ) : null}
              </div>
            );

            const plainActionExtra = (
              <>
                {transitionError ? (
                  <p
                    className="rounded-lg border border-destructive/30 bg-destructive-tint px-3 py-2 text-xs text-foreground"
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
                    onClick={() => setRejectPanelOpen(true)}
                  >
                    <XCircle className="size-4" />
                    {t('gateReject')}
                  </Button>
                  <Button
                    className="min-h-12 flex-1 gap-1.5"
                    disabled={resolving || (requiresOptionChoice && !selectedOption)}
                    // story #3113(AC3) — 선택안을 note에 실어 resolution_note로 영구 기록.
                    onClick={() => void transition('approved', requiresOptionChoice ? t('decisionSelectedNote', { option: selectedOption ?? '' }) : undefined)}
                  >
                    <CheckCircle className="size-4" />
                    {resolving ? '...' : t(approveButtonLabelKey)}
                  </Button>
                </div>
                {requiresOptionChoice && !selectedOption ? (
                  <p className="text-center text-xs text-muted-foreground">{t('decisionSelectHint')}</p>
                ) : null}
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
              </>
            );

            const asideExtras = (
              <>
                {/* story #3806 PR 10(페드루 PO 실측 2026-09-11 16:18Z — 결함 1) — ads_boost
                    실행 블록(실행 중/시작·중지)을 gate.status===`'approved'`로 게이트하면
                    「승인됨→예산·기간 변경→pending 재오픈(reapproval_required)」 도중 실제로는
                    아직 run_status='running'(집행 中)인데도 화면에서 통째로 사라져 중지 스위치를
                    잃는다(재승인까지). needsAction/canAct 분기와도 무관하게 항상 마운트해(위
                    §2902·§2975 AC4와 같은 원칙) `BoostExecutionControl` 자신의 run_status
                    폴링이 판단한다 — gate.status가 pending이든 approved든 「결재 대기(변경
                    재승인)」 배지와 「실행 중 · 중지」가 같은 화면에 공존(다른 메커니즘=다른
                    낱말로, 뭉개지 않는다). sealed_ads_starts_at이 아직 없으면(진짜 미승인·최초
                    요청) 컴포넌트 자신이 null을 반환해 지어내지 않는다. */}
                {gate.gate_type === 'ads_boost' && gate.org_id ? (
                  <BoostExecutionControl
                    orgId={gate.org_id} gateId={gate.id}
                    sealedAdsBudgetMinor={gate.sealed_ads_budget_minor ?? null}
                    sealedAdsCurrency={gate.sealed_ads_currency ?? null}
                    sealedAdsStartsAt={gate.sealed_ads_starts_at ?? null}
                    sealedAdsEndsAt={gate.sealed_ads_ends_at ?? null}
                    sealedAdsObjective={gate.sealed_ads_objective ?? null}
                    onSpendRefreshed={() => setActivityRefreshKey((k) => k + 1)}
                  />
                ) : null}

                {/* story #2902(후보 B, S2h①③ list_entity_backlinks 확장 소비처) — 「이 게이트를
                    언급한 대화」 역참조. 기성 EntityBacklinksSection(3곳 소비 중) 그대로 재사용 —
                    신규 뷰어 0. gate는 TARGET_ONLY라 액션 없이 조회만(§8 계약과 정합). */}
                <EntityBacklinksSection entityType="gate" entityId={gate.id} />

                {/* story #2975 AC4(PO 확定 2026-08-24) — 결재 이력(누가·언제·무엇을·어느 SHA에).
                    needsAction/canAct 분기와 무관하게 항상 렌더 — 감사 표면은 액션 가능 여부와
                    별개로 "사람이 보는 쪽"에 항상 서 있어야 실사고 때 쓰인다(PO 요구 ㉯). */}
                <div className="border-t border-proof-line-soft pt-3">
                  <GateActivityHistory gateId={gate.id} refreshKey={activityRefreshKey} />
                </div>
              </>
            );

            const proofCapsuleEl = (
              <ProofCapsule
                density="full"
                proofState={deriveGateProofState(gate.status).proofState}
                stateLabel={(() => {
                  const { statusKey } = deriveGateProofState(gate.status);
                  return statusKey ? t(statusKey) : gate.status;
                })()}
                claim={decisionFacts?.question ?? gate.work_item_summary?.title ?? `#${gate.work_item_id.slice(0, 8)}`}
                className="max-w-none"
                footer={
                  showActionColumn ? (
                    // story #4121(페드루 PO CHANGES-1 정정, 2026-09-21 18:14Z) — 우 열이
                    // 실제로 그려지는 갈래(c·d)에선 이 캡슐 footer엔 좌 열 콘텐츠(산출물·초안·
                    // 역참조·이력)만 남는다 — 우 열(facts+액션)은 이제 캡슐 밖 형제 카드로
                    // 옮겨졌다(sticky 스크롤 컨테이너 버그, 아래 gate-detail-container 주석
                    // 참조).
                    <div className="mt-3.5 space-y-3 border-t border-proof-line-soft pt-3">
                      {evidencePanels}
                      {asideExtras}
                    </div>
                  ) : (
                    // story #4121 — 우 열이 빌 자리(이미 해소·무권한, 4갈래 a·b)는 기존
                    // 단일열 그대로(diff 0 — 순서·폭 회귀 없음).
                    <div data-testid="gate-detail-single-col" className="mt-3.5 space-y-3 border-t border-proof-line-soft pt-3">
                      {gateMetaFacts}
                      {!needsAction ? (
                        <div className="space-y-3">
                          {evidencePanels}
                          {resolvedStatusExtra}
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {evidencePanels}
                          {gate.deferred_to_gate_id ? deferredExtra : unauthorizedExtra}
                        </div>
                      )}
                      {asideExtras}
                    </div>
                  )
                }
              />
            );

            if (!showActionColumn) return proofCapsuleEl;

            // story #4121(페드루 PO CHANGES-1, 2026-09-21 18:14Z) — 2열 grid는
            // gate-detail-container(페이지 레벨, ProofCapsule 밖)에서 걸린다(위 컨테이너
            // className 주석 참조) — 여기선 ProofCapsule과 우 열 액션 카드를 «형제»로만
            // 반환한다(Fragment — 감싸는 DOM 없이 그리드 아이템 2개가 그대로 노출).
            // 우 열은 캡슐과 같은 재질(proof-surface, doc ea94dac4 정본)이지만
            // proof-surface-lift만 쓰고 overflow-hidden은 뺀다(그게 sticky를 깨는
            // 원인이었다 — CutCornerShell 주석 §2978 참조, shrink-0도 overflow-hidden의
            // 부작용 상쇄용이라 같이 불요해짐).
            return (
              <>
                {proofCapsuleEl}
                <div
                  data-testid="gate-detail-action-column"
                  className="proof-surface proof-surface-lift mt-3 space-y-3 border border-proof-line bg-proof-panel p-4 lg:mt-0 lg:sticky lg:top-12 lg:self-start"
                >
                  {gateMetaFacts}
                  {isSigFlowGate || rejectPanelOpen ? signatureBlock : <div className="space-y-3">{plainActionExtra}</div>}
                </div>
              </>
            );
          })()
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
