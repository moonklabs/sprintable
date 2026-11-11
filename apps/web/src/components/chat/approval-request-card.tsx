'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Forward } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Button as DsButton } from '@/components/ds/button';
import { ApprovalActions, ApprovalCard, type ApprovalResolution, type ApprovalState } from '@/components/ds/approval-card';
import { Skeleton } from '@/components/ui/skeleton';
import { OperatorDropdownSelect, type SelectOption } from '@/components/ui/operator-dropdown-select';
import { GateSignatureApproval } from '@/components/cage/gate-signature-approval';
import { GateUndoButton, isUndoEligible } from '@/components/cage/gate-undo-button';
import { GateDiscussDialog } from '@/components/cage/gate-discuss-dialog';
import { deriveRiskLevel, usesSignatureFlow, isRecipePublishGate, reviewedDraftOf } from '@/components/cage/gate-risk';
import { buildGateTransitionBody } from '@/lib/gate-decision-payload';
import { memberLookup } from '@/lib/member-display';
import { pickIGaJosa } from '@/lib/korean-particle';
import { EntityPreviewModal, canPreviewEntity, getEntityHref } from '@/components/chat/embed-card';
import { useReadingPanel } from '@/components/chat/reading-panel-context';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem } from '@/components/kanban/types';
import { parseBlockTemplate, renderBlockTemplate, type EventDefinitionSummary } from '@/lib/block-template';
import { renderStaticEventBlock } from '@/components/chat/event-block-card';
import { useSseMultiplexerContext } from '@/components/realtime-provider';

import { escapeMarkdownLinkText } from '@/components/chat/chat-input-entity-tokens';
import { gateTypeLabel } from '@/lib/gate-type-label';
import { fetchWithAuth } from '@/lib/db/client';
import { ORG_NAMES_URL } from '@/hooks/use-member-name-fallback';
import { fetchGateById } from '@/lib/fetch-gate';
import { buildApproverPickerOptions } from '@/lib/approver-picker-options';
import { useToast } from '@/components/ui/toast';
import { TossSheet } from '@/components/chat/toss-sheet';
import { useFlatHref } from '@/hooks/use-flat-href';
import { withProjectParam } from '@/lib/with-project-param';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';

export interface ApprovalTarget {
  work_item_type: string;
  work_item_id: string;
  gate_id: string;
  /** story #2624 — 결재 "결과" 메시지(message_kind=result, BE #3015)의 approval_target은
   * actions가 없다(액션 카드가 아니라 회신 카드라 승인/반려 선택지 자체가 없음). 이 필드는
   * 이 컴포넌트에서 실제로 읽히지 않는다(gate 상태는 항상 fetchGate()의 실물로 판단) —
   * optional로 둬 두 메시지 종류(request/result) 모두 같은 타입으로 수용한다. */
  actions?: string[];
  /** story #2985 — 결재선 지정 시 이 카드가 지정 결재자에게 간 액션 카드인지. story #3001
   * (선생님 정책 확定) 이후로는 카드 자체가 지정자에게만 발행되므로(비지정자는 카드 자체를
   * 못 받는다) 항상 true와 동형 — 이 필드는 구메시지 호환용으로만 남는다. */
  designated?: boolean;
  /** story #2985 — 발송 당시 지정 결재자 표시 이름(스냅샷). story #3001부터는 정보성 카드
   * 문구용으로는 쓰이지 않는다(그 렌더 자체가 폐기) — 남겨는 두되 현재 미사용. */
  designated_approver_name?: string | null;
}

interface ApprovalRequestCardProps {
  target: ApprovalTarget;
  /** story #2637 AC4(PO 08-14 확定) — chat-view.tsx가 대화당 1회 배치조회한 event_definitions
   * 카탈로그를 그대로 물려받는다(eventDefinitionsByKey와 동일 패턴, 별도 fetch 안 만든다).
   * resolved(회신) 분기가 이 카탈로그의 preset.gate.verdict 항목을 찾아 정적 표현부(text·
   * fields)만 소비한다 — pending(요청·서명·버튼) 분기는 그대로다. */
  eventDefinitionsByKey?: Record<string, EventDefinitionSummary> | null;
  /** story #5ace2e84(2026-08-28 라이브 재측 후속) — chat-view.tsx가 대화 단위로 배치조회한
   * gate_id→상태 맵 «전체»(use-gate-batch.ts). ⚠️단건 lookup만 넘기던 구판은 첫 마운트
   * 레이스가 있었다 — React는 같은 커밋에서 자식(이 카드) effect를 부모(useGateBatchFetch)
   * effect보다 먼저 돌리므로, 그 시점 맵이 아직 `{}`라 모든 카드가 "커버 안 됨"으로 오판해
   * 배치가 뜨기도 전에 개별 fetchGate()를 전원 발사했다(라이브 실측: 대화당 여전히 ~50발 —
   * 배치 자체는 33개를 1콜로 정확히 묶었지만 개별 콜을 막지 못함). 처방: **맵 객체 자체**
   * (이 gate_id 항목이 아직 없어도, 빈 `{}`라도)를 "이 화면은 배치가 관장한다"는 신호로
   * 쓴다 — 정의돼 있으면 항목이 없어도 기다리고, undefined(배치 컨텍스트 자체가 없음 —
   * approvals-queue.tsx처럼 채팅 밖에서 쓰이는 경우)일 때만 개별 fetchGate()로 폴백
   * (회귀 0). */
  gateByKey?: Record<string, CardState>;
}

/** story #5ace2e84 — use-gate-batch.ts(chat-view.tsx 대화 단위 배치조회)와 정확히 같은 shape을
 * 공유하기 위해 export한다(타입 두 벌 갈라지는 drift 방지 — entity-status-labels.ts의
 * EntityStatusFetchState와 동일 정신). */
export type CardState =
  | { kind: 'loading' }
  /** 게이트가 없다(삭제 등) — AC4류 폴백: 조용한 실패 대신 정직한 문구. */
  | { kind: 'not-found' }
  | { kind: 'error' }
  | { kind: 'ready'; gate: GateItem };

// story #2118(E-DG-REAL) — Gate.work_item_type과 embed-card.tsx의 entity_type 어휘는 대부분
// 같은 문자열이지만 둘이 갈리는 자리가 있다(gate_service.py:194 vs embed-card.tsx ENTITY_ICONS
// 키 대조로 확認): Gate는 "visual_artifact"를 쓰는데 entity 계열은 "artifact"다. 이 변환 없이
// 그대로 룩업하면 visual_artifact 게이트만 조용히 제네릭 아이콘/미리보기 없음으로 떨어진다
// (버그가 아니라 보이는 실패였을 뿐 — 그래도 있는 지원을 안 쓰는 건 낭비). "loop"처럼 entity
// 계열에 아예 없는 타입은 그대로 흘려보낸다 — resolveEntityIcon/EntityPreviewModal 둘 다
// 미등록 타입을 크래시 없이 정직하게 폴백한다(초성 아이콘·"별도 미리보기가 없습니다").
export function toEntityType(workItemType: string): string {
  return workItemType === 'visual_artifact' ? 'artifact' : workItemType;
}

// story #2624 — 회신 카드가 gate.status 원문("approved"/"rejected" 등)을 그대로 보였다(선생님
// 지적 — "사유는 남겨놨는데" 인시던트의 human 웹 표면 절반). i18n 키가 있는 상태만 번역하고,
// 매핑 안 된 값(held/voided 등 흔치 않은 상태)은 원문을 그대로 보여 조용히 숨기거나 지어내지
// 않는다.
const RESOLVED_STATUS_LABEL_KEYS: Record<string, string> = {
  approved: 'approvalRequestStatusApproved',
  rejected: 'approvalRequestStatusRejected',
  held: 'approvalRequestStatusHeld',
  voided: 'approvalRequestStatusVoided',
  // story 4887 (UI-4 P4-c) — a merge gate can pass by itself (backend GATE_STATUSES · allow_auto / the re-evaluation of a pending gate): the card used to print the raw word «auto_passed» with the rejection's X icon.
  auto_passed: 'approvalRequestStatusAutoPassed',
};

/**
 * story #2604 P2 → #2625(선생님 실사용 판정으로 확장) — chat approval-request 카드. BE(#3007)가
 * payload에 실은 `approval_target`(work_item_type/work_item_id/gate_id/actions)을 렌더한다.
 * 새 API는 만들지 않는다(AC③) — 상태 조회는 기존 `GET /api/gates/{id}`, 액션은 기존
 * `POST /api/gates/{id}/transition` 그대로(gates/[id]/page.tsx와 동일 계약·동일 envelope
 * 언랩) — human-only SoD 인가는 그 엔드포인트가 이미 지킨다(신규 인가 없음).
 *
 * story #2625 — 고위험(usesSignatureFlow)도 이제 챗을 벗어나지 않고 완결된다. 원래는
 * "결재함에서 열기" 링크로 위임했으나(#3011, no-fiction 원칙 하 재구현 회피), 선생님이
 * 직접 실사용 중 그 네비게이션 자체를 UX 결함으로 판정(gate 34af76dc 반려 사유) — 서명
 * 플로우(`GateSignatureApproval`)를 gates/[id]/page.tsx와 **그대로 공유 재사용**해 챗
 * 카드 안에 얹는다(사본 분화 금지, AC③).
 *
 * story #2627 — 선생님 실사용 반려(gate 0db49ffc): "본문을 이 챗 UI 안에서 확인할 방법이
 * 없다"는 지적. 액션(#2625)은 챗 안인데 판단 재료(doc 본문)가 밖이라 반쪽이었다 — 카드
 * 제목을 `EntityPreviewModal`(embed-card.tsx, #2614에서 doc 본문 렌더를 이미 지원하도록
 * 수리된 그 표면) 진입점으로 연결한다. 신규 뷰어 없음(export만 추가) · 서명 플로우
 * (`GateSignatureApproval`)와 형제로 렌더돼 모달 열람/닫기가 그 로컬 state(근거확인·사유)를
 * 건드리지 않는다(AC③, 언마운트 없음).
 */
export function ApprovalRequestCard({ target, eventDefinitionsByKey, gateByKey }: ApprovalRequestCardProps) {
  const flatHref = useFlatHref(); // story #4231 3차 — 엔티티 링크(문서 · flat)는 현재 프로젝트를 싣는다
  const t = useTranslations('chats');
  // story #2926(P0-F 잔여 fast-follow, 카디르 F2 QA LOW①) — 아래 stateLabel 유도가
  // deriveGateProofState()의 통일 키(gateStatus*)를 쓴다 — 그 키들은 'cage' 네임스페이스.
  const tCage = useTranslations('cage');
  const tc = useTranslations('common');
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const [resolving, setResolving] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  // story #2926(P0-F F1) — claim 클릭(제목 미리보기)이 이제 ProofCapsule 셸 소관이라 이
  // state도 그쪽에 맞춰 여기(바깥 컴포넌트)로 끌어올렸다(기존 ApprovalRequestBody 소유였음).
  const [showPreview, setShowPreview] = useState(false);
  // story #461e9a54(P0) — approvals-queue.tsx(인박스, 채팅 밖)에서도 이 카드가 쓰인다 —
  // Provider 밖이면 null이라 기존 Dialog 모달 폴백(회귀 0).
  const readingPanel = useReadingPanel();
  // story #3084(2026-08-25 층3) — 토스 성공/409 안내용. 이 카드 인스턴스 로컬(다른 카드
  // 인스턴스와 공유 안 함) — attachment-file.tsx와 동일 선례, ToastContainer도 이 카드가
  // 직접 렌더한다(fixed 오버레이라 DOM 위치 무관하게 뜬다).
  const { addToast } = useToast();

  const fetchGate = useCallback(async () => {
    // story #4253 — 공용 fetchGateById(날 GateResponse 한 모양 · 404 = not-found · 그 밖 = error).
    const result = await fetchGateById<GateItem>(target.gate_id);
    setState(result.kind === 'ok' ? { kind: 'ready', gate: result.gate } : { kind: result.kind });
  }, [target.gate_id]);

  // story #5ace2e84(2026-08-28 라이브 재측 후속) — gateByKey «맵 객체 자체»가 정의돼 있으면
  // (빈 `{}`라도) 이 화면은 배치가 관장한다는 뜻 — 이 gate_id 항목이 아직 안 채워졌어도
  // 독립 fetchGate()를 안 태우고 기다린다(첫 마운트 레이스 처방, 위 prop 문서 참고).
  // gateByKey 자체가 undefined일 때만(배치 컨텍스트 자체가 없음 — approvals-queue.tsx 등)
  // 기존 개별 fetchGate()로 자연 폴백한다(회귀 0).
  const initialGate = gateByKey?.[target.gate_id];
  useEffect(() => {
    if (initialGate) { setState(initialGate); return; }
    if (gateByKey !== undefined) return; // 배치가 관장 중 — 항목 도착까지 대기.
    void fetchGate();
  }, [fetchGate, initialGate, gateByKey]);

  // story #2985 AC2(PO 계약 확定 2026-08-24) — 다른 승인자가 이 게이트를 먼저 해소하면,
  // 이 카드를 보고 있는 화면도 새로고침 없이 "처리됨"으로 갱신된다. BE가
  // notify_gate_card_recipients_resolved(approval_delivery.py)에서 원 카드(액션+정보성
  // 무관) 받았던 전원에게 새 ConversationMessage 없이 순수 SSE 이벤트만 심는다 — 그 계약의
  // FE 절반. mux가 없으면(RealtimeProvider 밖·플래그 OFF) 조용히 스킵 — 이 경우 기존처럼
  // 마운트 1회 fetchGate만 유효(회귀 아님, 저하일 뿐).
  const mux = useSseMultiplexerContext();
  useEffect(() => {
    if (!mux) return;
    const unsub = mux.subscribe('conversation.gate_resolved', (raw) => {
      try {
        const payload = JSON.parse(raw) as { gate_id?: string };
        if (payload.gate_id === target.gate_id) void fetchGate();
      } catch { /* malformed — 무시(다음 정상 이벤트나 fetchGate 재시도로 자연 회복) */ }
    });
    return unsub;
  }, [mux, target.gate_id, fetchGate]);

  // story #3001(위임) — 원 지정자가 위임으로 밀려나면(gate.designated_approver_id가
  // 더 이상 자신이 아니게 되면) 그 사람이 보고 있는 이 카드도 새로고침 없이 "위임됨"으로
  // 갱신된다. BE notify_gate_delegated_to_old_approver가 gate_resolved와 동형 계약
  // (ConversationMessage 없이 순수 SSE 이벤트만) — 동일 구독 패턴 재사용.
  useEffect(() => {
    if (!mux) return;
    const unsub = mux.subscribe('conversation.gate_delegated', (raw) => {
      try {
        const payload = JSON.parse(raw) as { gate_id?: string };
        if (payload.gate_id === target.gate_id) void fetchGate();
      } catch { /* malformed — 무시 */ }
    });
    return unsub;
  }, [mux, target.gate_id, fetchGate]);

  // story #3084(2026-08-25 층3, PO 확定 — FE 요건②) — 이 gate_id의 사본을 갖고 있던 모든
  // conversation 수신자에게 방출되는 순수 SSE 이벤트(gate_resolved/gate_delegated와 동형,
  // 새 ConversationMessage는 안 만듦). conversation_id 무관 gate_id 매칭이라 신규 사본이
  // 하나 더 생겼다는 사실이 이미 열린 화면 전부(원 카드·기존 사본 전부)에 자동 반영된다 —
  // AC2(여러 방 동기 전이)의 FE 절반이 이 구독 하나로 끝난다.
  useEffect(() => {
    if (!mux) return;
    const unsub = mux.subscribe('conversation.gate_tossed', (raw) => {
      try {
        const payload = JSON.parse(raw) as { gate_id?: string };
        if (payload.gate_id === target.gate_id) void fetchGate();
      } catch { /* malformed — 무시 */ }
    });
    return unsub;
  }, [mux, target.gate_id, fetchGate]);

  const transition = async (status: 'approved' | 'rejected', note?: string, evidenceViewed?: boolean): Promise<boolean | void> => {
    setResolving(true);
    setTransitionError(null);
    try {
      const res = await fetchWithAuth(`/api/gates/${target.gate_id}/transition`, { timeoutMs: LONG_ROUTES.gateTransition.browserMs,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // story #2027 AC2 — gates/[id]/page.tsx와 동일 계약(evidence_viewed는 고위험 서명
        // 플로우 onApprove에서만 true로 실린다, 아래 ApprovalRequestBody 배선 참조).
        // story #2975 회귀 자체발견(#2982 작업 중) — reviewed_head_sha 누락(gates/[id]/
        // page.tsx만 #2975에서 고쳐지고 이 챗 카드는 빠져 있었다). known SHA 있는 merge
        // 게이트를 이 카드에서 승인하면 #3410 착지 後 항상 409(gate_head_changed)로
        // 거부되는 라이브 회귀 — state.gate(fetchGate 실측)에서 채운다.
        // story #4190 — 레시피 발행 게이트면 서명 패널의 초안 카드가 그린 (draft_id, version)도(없으면 키 없음).
        body: JSON.stringify(buildGateTransitionBody({
          status, note, evidenceViewed,
          reviewedHeadSha: state.kind === 'ready' ? (state.gate.github_check_run_sha ?? null) : null,
          reviewedDraft: state.kind === 'ready' ? reviewedDraftOf(state.gate) : null,
        })),
      });
      if (res.ok) { await fetchGate(); return true; }  // story #4370 — 서명 사유 초안을 지우는 신호
      const body = await res.json().catch(() => null) as { error?: { message?: string; code?: string } } | null;
      const code = body?.error?.code;
      // story #2975·#2982(PO 확定) — code 부착 거부는 raw BE 문구(한국어 평문) 대신 사람
      // 문구로 매핑(gates/[id]/page.tsx와 동형). 둘 다 "화면이 아는 상태가 서버와
      // 어긋났다"는 뜻이라 재조회로 실제 현재 상태를 반영(AC1 — 죽은 버튼이 다시 안 뜬다).
      if (code === 'gate_head_changed' || code === 'gate_draft_changed' || code === 'gate_already_resolved') {
        await fetchGate();
      }
      setTransitionError(
        code === 'gate_head_changed' ? tCage('gateHeadChangedError')
          : code === 'gate_draft_changed' ? tCage('gateDraftChangedError')
          : code === 'gate_already_resolved' ? tCage('gateAlreadyResolvedError')
          : (body?.error?.message ?? `HTTP ${res.status}`)
      );
    } catch {
      setTransitionError(t('hitlSendFailed'));
    } finally {
      setResolving(false);
    }
  };

  // story #2631 — «보류(논의 필요)». transition()과 형제 함수: 같은 gate_id, 다른 엔드포인트,
  // 성공해도 상태 전이가 없어(pending 유지) fetchGate()로 다시 물어 discussion_requested만
  // 갱신한다.
  const [discussDialogOpen, setDiscussDialogOpen] = useState(false);
  const [discussSubmitting, setDiscussSubmitting] = useState(false);
  const [discussError, setDiscussError] = useState<string | null>(null);
  const discuss = async (reason: string): Promise<boolean> => {
    setDiscussSubmitting(true);
    setDiscussError(null);
    try {
      const res = await fetchWithAuth(`/api/gates/${target.gate_id}/discuss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (res.ok) {
        await fetchGate();
        setDiscussDialogOpen(false);
        // story #3258(customer-zero 2차) — 성공해도 gate.status가 그대로(pending 유지)라
        // 다이얼로그가 닫히는 것 말고는 화면에 아무 신호가 없었다(선생님 실사용 02:19:26/28/33
        // 3연발 재현 — 눌러도 반응이 안 보여 반복 클릭). 즉시 토스트로 "보냈다"는 사실 자체를
        // 확인시킨다 — 지속 신호(누가 봐도 남는 배너)는 아래 discussion_requested 렌더가 맡는다.
        addToast({ type: 'success', title: t('approvalRequestDiscussSuccessToast') });
        return true;
      }
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setDiscussError(body?.error?.message ?? `HTTP ${res.status}`);
      return false;
    } catch {
      setDiscussError(t('hitlSendFailed'));
      return false;
    } finally {
      setDiscussSubmitting(false);
    }
  };

  // story 4887 (UI-4 P4-c) — loading / not-found / error are the ds ApprovalCard's own states (the label stays so the card is still recognisable; no title is invented while the gate is unknown).
  if (state.kind !== 'ready') {
    return (
      <ApprovalCard
        label={t('approvalRequestLabel')}
        title=""
        state={state.kind === 'loading'
          ? { kind: 'loading', loadingLabel: tc('loading') }
          : state.kind === 'not-found'
            ? { kind: 'not-found', message: t('approvalRequestNotFound') }
            : { kind: 'error', message: t('approvalRequestLoadError') }}
      />
    );
  }

  const gate = state.gate;
  const title = gate.work_item_summary?.title ?? `#${gate.work_item_id.slice(0, 8)}`;
  const previewEntityType = toEntityType(gate.work_item_type);
  const canPreview = canPreviewEntity(previewEntityType);
  // story #3258(customer-zero 2차) AC1/AC4 — doc.py transition_doc()이 심은 gate.neutral_facts.
  // doc_diff({add,del})를 카드 헤더(claim 바로 아래)에 새 컴포넌트 없이 기존 ProofCapsule
  // evidence 슬롯으로 노출한다(사본 분화 금지 — proof-capsule.tsx CardVariant가 이미
  // evidence.diff를 그린다). 재상신(반려→개정) 카드에서만 존재(no-fiction).
  const docDiff = (() => {
    const raw = gate.neutral_facts?.['doc_diff'];
    if (raw && typeof raw === 'object'
      && typeof (raw as Record<string, unknown>)['add'] === 'number'
      && typeof (raw as Record<string, unknown>)['del'] === 'number') {
      const r = raw as Record<string, number>;
      return { add: r['add'], del: r['del'] };
    }
    return null;
  })();

  // story #4253(까디르 codex · PO 09:45Z) — 채팅의 승인 요청 카드는 조직 전체가 보는 자리라 작업 항목 링크는 게이트 자기 프로젝트(gate.project_id)
  // · 모를 때만 현재 p.
  const gateProjectHref = gate.project_id ? (h: string) => withProjectParam(h, gate.project_id ?? null) : flatHref;
  return (
    <>
      <ApprovalRequestBody
        gate={gate}
        title={title}
        docDiff={docDiff}
        onTitleClick={canPreview ? () => {
          if (readingPanel) {
            readingPanel.open({
              kind: 'entity', entityType: previewEntityType, entityId: gate.work_item_id,
              title, status: null, href: getEntityHref(previewEntityType, gate.work_item_id, gateProjectHref),
            });
            return;
          }
          setShowPreview(true);
        } : undefined}
        resolving={resolving}
        transitionError={transitionError}
        onApprove={(reason, evidenceViewed) => transition('approved', reason, evidenceViewed)}
        onReject={(reason) => transition('rejected', reason)}
        onDiscuss={(reason) => void discuss(reason)}
        onDiscussClick={() => setDiscussDialogOpen(true)}
        onUndone={() => void fetchGate()}
        eventDefinitionsByKey={eventDefinitionsByKey}
        addToast={addToast}
      />
      <GateDiscussDialog
        open={discussDialogOpen}
        onOpenChange={setDiscussDialogOpen}
        onSubmit={discuss}
        submitting={discussSubmitting}
        error={discussError}
        targetId={target.gate_id}
      />
      {!readingPanel && showPreview && (
        <EntityPreviewModal
          entityType={previewEntityType}
          entityId={gate.work_item_id}
          title={title}
          status={null}
          href={getEntityHref(previewEntityType, gate.work_item_id, gateProjectHref)}
          onClose={() => setShowPreview(false)}
        />
      )}
    </>
  );
}

function ApprovalRequestBody({
  gate, title, docDiff, onTitleClick, resolving, transitionError, onApprove, onReject, onDiscuss, onDiscussClick, onUndone, eventDefinitionsByKey,
  addToast,
}: {
  gate: GateItem;
  title: string;
  /** story #3258 AC4 — the re-submitted doc's diff size (add / del), shown as a line in the card's material. */
  docDiff: { add: number; del: number } | null;
  /** The title becomes a button that opens the body preview (reading panel or modal) — only for a type that can be previewed. */
  onTitleClick?: () => void;
  resolving: boolean;
  transitionError: string | null;
  onApprove: (reason?: string, evidenceViewed?: boolean) => void | Promise<boolean | void>;
  onReject: (reason?: string) => void | Promise<boolean | void>;
  /** story #2631 — 고위험(서명) 플로우가 이미 가진 사유 필드를 그대로 재사용해 직접 제출. */
  onDiscuss: (reason: string) => void;
  /** story #2631 — 저위험 플로우엔 사유 입력창이 없어 별도 다이얼로그를 연다. */
  onDiscussClick: () => void;
  onUndone: () => void;
  eventDefinitionsByKey?: Record<string, EventDefinitionSummary> | null;
  /** story #3084(층3) — 토스 성공/409 안내 토스트(카드 인스턴스가 소유한 useToast, 부모가 전달). */
  addToast: (toast: { type?: 'info' | 'warning' | 'success' | 'error'; title: string; body?: string }) => void;
}) {
  const flatHref = useFlatHref(); // story #4231 3차 — 본문 엔티티 칩(문서 · flat)은 현재 프로젝트를 싣는다
  // story #4253(까디르 codex 01a0d316) — 풀린 템플릿의 대상 칩은 게이트 자기 프로젝트 · 모를 때만 현재 p.
  const gateProjectHref = gate.project_id ? (h: string) => withProjectParam(h, gate.project_id ?? null) : flatHref;
  const t = useTranslations('chats');
  // gates/[id]/page.tsx와 같은 문구를 쓴다(동일 개념=동일 어휘, DS 원칙) — 그 키들은 'cage'
  // 네임스페이스에 있다('chats'엔 없음, 그라운딩 중 확認).
  const tCage = useTranslations('cage');
  const tc = useTranslations('common');
  const tDashboard = useTranslations('dashboard');
  const tEventCard = useTranslations('eventCard');
  const { currentTeamMemberId, projectId } = useDashboardContext();

  // story #3084(2026-08-25, 유나 픽셀 규격 v1 §부록A — 상태 파생표 SSOT) — «대기·requester»/
  // «대기·관찰자»/토스 시트 문구가 필요로 하는 이름 2종(designated_approver_id·resolver_id)을
  // gates/[id]/page.tsx의 fetchedResolverIdRef 관례와 동형으로 지연 조회한다(카드마다 독립
  // — DelegateApprovalControl의 openPicker on-demand 조회와 같은 결).
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  // [SID:4286] 이름 표를 다 불러왔는지(성공 · 실패 모두 끝) — 불러오는 중에는 «알 수 없음»을 먼저 띄우지 않는다.
  const [memberNamesLoaded, setMemberNamesLoaded] = useState(false);
  const fetchedNameIdsRef = useRef<string | null>(null);
  const requesterId = (() => {
    const raw = gate.neutral_facts?.['requested_by_member_id'];
    return typeof raw === 'string' ? raw : null;
  })();
  const hasDesignatedLine = !!gate.designated_approver_id;
  const isDesignatedViewer = hasDesignatedLine && gate.designated_approver_id === currentTeamMemberId;
  const isRequesterViewer = !isDesignatedViewer && !!requesterId && requesterId === currentTeamMemberId;
  const needsDesignatedName = gate.status === 'pending' && hasDesignatedLine && !isDesignatedViewer;
  const needsResolverName = gate.status !== 'pending' && !!gate.resolver_id && gate.resolver_id !== currentTeamMemberId;
  // story #3151 — AC1 "요청자 표시"는 뷰어 역할과 무관하게 항상 필요(대기/기결 둘 다, 결정
  // 재료의 일부라 승인자·구경꾼 가리지 않는다) — 위 두 플래그(대기 상태·본인 여부로 분기)와
  // 다른 축이라 별도 플래그로 둔다.
  const needsRequesterName = !!requesterId && requesterId !== currentTeamMemberId;
  // story #3258(customer-zero 2차) — gate_service.py request_gate_discussion()이 이미
  // neutral_facts.discussion_requested={reason, requested_by_member_id, requested_at}를
  // 심는데 이 카드가 한 번도 읽지 않았다 — 성공해도 화면에 아무 신호가 안 남아 재클릭
  // (선생님 실사용 02:19:26/28/33 3연발)을 유발한 근본. pending인 동안 지속 배너로 노출.
  const discussionRequested = (() => {
    const raw = gate.neutral_facts?.['discussion_requested'];
    if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>)['reason'] === 'string') {
      const r = raw as Record<string, unknown>;
      return {
        reason: r['reason'] as string,
        requestedByMemberId: typeof r['requested_by_member_id'] === 'string' ? r['requested_by_member_id'] as string : null,
      };
    }
    return null;
  })();
  const needsDiscussRequesterName = !!discussionRequested?.requestedByMemberId
    && discussionRequested.requestedByMemberId !== currentTeamMemberId;
  useEffect(() => {
    const idsKey = `${needsDesignatedName ? gate.designated_approver_id : ''}|${needsResolverName ? gate.resolver_id : ''}|${needsRequesterName ? requesterId : ''}|${needsDiscussRequesterName ? discussionRequested?.requestedByMemberId : ''}`;
    if (idsKey === '|||' || fetchedNameIdsRef.current === idsKey) return;
    fetchedNameIdsRef.current = idsKey;
    // [SID:4300] 이름만 쓰는 표 — 비활성 에이전트도 «목록이 거른 것»이라 비활성까지 싣는 조직 원천(떠난 사람은 BE 4303 대기).
    void fetchWithAuth(ORG_NAMES_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: { id: string; name: string }[] } | null) => {
        if (!json?.data) return;
        const names: Record<string, string> = {};
        for (const m of json.data) names[m.id] = m.name;
        setMemberNames((prev) => ({ ...prev, ...names }));
      })
      .catch(() => { /* non-critical — 표에 없으면 «알 수 없는 구성원»(id 조각 0 · story #4286) */ })
      .finally(() => setMemberNamesLoaded(true));
  }, [needsDesignatedName, needsResolverName, needsRequesterName, needsDiscussRequesterName, gate.designated_approver_id, gate.resolver_id, requesterId, discussionRequested?.requestedByMemberId]);
  // [SID:4286] id 조각(앞 8자)을 이름 칸에 싣지 않는다 — memberLookup(표에 없음 → «알 수 없는 구성원» · 불러오는 중 → null).
  // fallback이면(이름 없음 · 알 수 없음) «님» 없는 문장 키로 간다(유나 결정 4).
  const designatedApprover = gate.designated_approver_id
    ? memberLookup(memberNames, gate.designated_approver_id, tc, { loaded: memberNamesLoaded })
    : null;
  const designatedApproverName = designatedApprover?.label ?? null;

  // story #3084 층3 — 토스 시트 open state. 진입점은 아래 canToss 게이트(designated 본인
  // ⋯ 오버플로 / requester 본인 "다른 방에도 보내기" 버튼) 둘 다 공유.
  const [tossOpen, setTossOpen] = useState(false);
  const canToss = gate.status === 'pending' && hasDesignatedLine && (isDesignatedViewer || isRequesterViewer);

  // story #2637 AC4(PO 08-14 확定, Q2/Q3 그라운딩) — resolved(회신) 분기만 preset.gate.verdict
  // block_template을 부분 소비(text·fields만 — header/actions는 안 씀, 「결재 요청」 라벨은
  // 그대로 카드 정체성으로 남는다). fetchGate()의 실물 데이터를 payload 동형 객체로 "합성"한다
  // (Pedro 표현) — 원본 gate.status/work_item_id를 날것 그대로 흘려보내지 않고, title 폴백은
  // 현행 로직 그대로 재사용(work_item_title 자리), verdict도 현행 RESOLVED_STATUS_LABEL_KEYS
  // 번역을 그대로 재사용(raw "approved"/"rejected" 영문 노출은 시각 퇴보 — Q2가 work_item_id
  // 건에서 확定한 "시각 동일 우선" 원칙을 verdict 필드에도 동형 적용). 템플릿 없음/파싱 실패는
  // 조용히 죽지 않고 아래 기존 하드코딩 렌더로 폴백(AC2 폴백 원칙과 동형 방어).
  const verdictLabel = RESOLVED_STATUS_LABEL_KEYS[gate.status] ? t(RESOLVED_STATUS_LABEL_KEYS[gate.status]!) : gate.status;
  const gateTypeLabelValue = gateTypeLabel(tDashboard, gate.gate_type);
  const resolvedStaticBlocks = gate.status !== 'pending' ? (() => {
    const definition = eventDefinitionsByKey?.['preset.gate.verdict'];
    const parsed = definition?.block_template ? parseBlockTemplate(definition.block_template) : null;
    if (!parsed) return null;
    const payload: Record<string, unknown> = {
      resolution_note: gate.resolution_note ?? null,
    };
    // story #3884(twin-pathway 동기화) — 0376 마이그가 preset.gate.verdict의 text/필드
    // 라벨 자리를 {{label.X}}/{{t.X}}로 옮겼다(원 계약이었던 {{payload.gate_type}}/
    // {{payload.verdict}}·정적 한국어 라벨은 더 이상 없음). 이 카드는 EventBlockCard와
    // 별개로 자체 fetchGate() 데이터를 "합성"해 같은 템플릿을 부분 소비하는 twin
    // 소비처라(story #2637 AC4) — EventBlockCard가 렌더 시점에 계산하는 값과 정확히
    // 같은 값을 여기서도 만들어 labels/translations로 넘겨야 한다(둘이 갈리면 한쪽만
    // 고쳐진 "쌍둥이 체계 약한 쪽" 결함 — 실측: 이 손 안 대면 gate_type/verdict가
    // ⟨missing: label.gate_type⟩ 그대로 새는 걸 node repro로 확認).
    // story #3332 — 0301 마이그가 preset.gate.verdict의 "대상" 필드를 참조 토큰으로
    // 바꿨다(지금은 0376의 {{label.work_item_target}} 경유). 이 카드는 서버가 계산해
    // 주는 refs를 못 받으므로(자체 fetchGate() 데이터로 합성하는 카드) 여기서 직접
    // 만든다 — title은 이 컴포넌트가 이미 쓰는 값(work_item_summary?.title 폴백 포함)
    // 그대로, escapeMarkdownLinkText는 BE build_reference_token과 동일 escape 규칙
    // (reference_token.py)의 FE 미러(chat-input-entity-tokens.ts) 재사용. 이 카드가
    // 다루는 게이트는 항상 fetchGate()로 실 조회된 row라 "리졸버는 있는데 못 찾음"
    // 분기(targetMissing) 자체가 이 pathway엔 없다 — 찾음 모양 하나로 충분.
    const labels: Record<string, string> = {
      gate_type: gateTypeLabelValue,
      verdict: verdictLabel,
      work_item_target: `[${escapeMarkdownLinkText(title)}](entity:${toEntityType(gate.work_item_type)}:${gate.work_item_id})`,
      gate_connective_line: tEventCard('gateConnective', { gateType: gateTypeLabelValue, verdict: verdictLabel }),
    };
    const translations: Record<string, string> = {
      targetLabel: tEventCard('targetLabel'),
      reasonLabel: tEventCard('reasonLabel'),
    };
    // PO 리뷰(head 81f7e4a7e) — resolution_note 없음은 템플릿 저자 실수(⟨missing⟩ 마커
    // 대상)가 아니라 정상적인 「선택값 부재」다(기존 카드도 사유 없으면 그 줄 자체를 안
    // 그렸다 — story #2624). 0375부터 그 필드 자체가 `optional: true`라(block-
    // template.ts의 elision이 payload.resolution_note===null을 자동으로 줄 생략시킨다)
    // 이 파일 자체의 수동 필터는 더 이상 필요 없지만, 명시적 방어로 남겨 둔다(제거는
    // 이 스토리 범위 밖 — 회귀 0 우선, 중복은 no-op이라 무해).
    const blocksToRender = gate.resolution_note
      ? parsed.blocks
      : parsed.blocks.map((b) => (
        b.type === 'fields' ? { ...b, fields: b.fields.filter((f) => f.value !== '{{payload.resolution_note}}') } : b
      ));
    return renderBlockTemplate({ blocks: blocksToRender }, payload, {}, labels, translations)
      .filter((b) => b.type === 'text' || b.type === 'fields');
  })() : null;
  const riskLevel = deriveRiskLevel(gate);
  const needsFullFlow = usesSignatureFlow(riskLevel);
  // story #3334(페드루 PO 리뷰 적출) — 저위험 게이트의 반려(변경 요청)는 예전엔 이 카드가
  // onReject()를 사유 없이 즉시 호출했다(gates/[id]/page.tsx·approvals-queue.tsx에 적용한
  // 동형 처방을 이 세 번째 표면엔 빠뜨렸던 것 — 채팅 결재 카드는 선생님이 가장 많이 쓰는
  // 표면이라 실사용에서 바로 걸림돌이 됐을 자리). 근거열람 없이도 반려 자체는 가능해야
  // 하므로(승인만 evidence 축) 저위험 게이트를 통째로 서명 플로우로 밀어넣지 않고, "반려
  // 하려는 의도"일 때만 이 토글로 같은 GateSignatureApproval 패널을 연다.
  // gate.id는 이 카드 인스턴스의 수명 동안 고정(target.gate_id로 매 폴링/재조회를 같은
  // 게이트에 거는 구조라 다른 게이트로 안 바뀐다) — 리셋 이펙트 불요.
  const [rejectPanelOpen, setRejectPanelOpen] = useState(false);
  // story #4190 — 레시피 발행 게이트의 «초안 보고 승인»이 여는 같은 서명 패널(초안 카드 포함).
  const [signPanelOpen, setSignPanelOpen] = useState(false);
  const canAct = gate.status === 'pending' && gate.can_approve === true;
  // story #3001 — 지정이 걸린 게이트인데 지금 이 카드를 보는 나는 더 이상 그 지정자가
  // 아니다(위임됨). 미지정(broadcast) 게이트는 gate.designated_approver_id가 애초 null이라
  // 이 분기 자체가 안 걸린다(회귀 0).
  const isDelegatedAway = gate.status === 'pending' && !!gate.designated_approver_id && gate.designated_approver_id !== currentTeamMemberId;
  const canDelegate = canAct && !isDelegatedAway && !!gate.designated_approver_id && gate.designated_approver_id === currentTeamMemberId;

  // story #3151(선생님 실기기 발견) — agent_decision 카드가 「결재 대기 / #해시 / 버튼」만
  // 보이고 무엇을 결재하는지가 전무했다. 게이트 실물(neutral_facts.question/options/
  // assumption, backend/app/routers/gates.py::DecisionRequestCreate)엔 재료가 이미 있는데
  // 이 카드가 한 번도 읽지 않았다 — work_item_summary(title 소스)가 agent_decision엔 애초
  // null이라 claim이 #해시로 폴백하는 것과 별개로, 그 아래 body에도 대체 재료가 없었다.
  // status·뷰어 역할과 무관하게 항상 보여야(AC1: "채팅 밖으로 안 나가고 결정 끝나나") 최상단
  // (위험 배지 다음)에 둔다.
  const isDecisionGate = gate.work_item_type === 'agent_decision';
  const decisionQuestion = isDecisionGate && typeof gate.neutral_facts?.['question'] === 'string'
    ? (gate.neutral_facts['question'] as string) : null;
  const decisionOptions = isDecisionGate && Array.isArray(gate.neutral_facts?.['options'])
    ? (gate.neutral_facts['options'] as unknown[]).filter((o): o is string => typeof o === 'string') : [];
  const decisionAssumption = isDecisionGate && typeof gate.neutral_facts?.['assumption'] === 'string'
    ? (gate.neutral_facts['assumption'] as string) : null;
  const requester = requesterId ? memberLookup(memberNames, requesterId, tc, { loaded: memberNamesLoaded }) : null;
  const discussRequester = discussionRequested?.requestedByMemberId
    ? memberLookup(memberNames, discussionRequested.requestedByMemberId, tc, { loaded: memberNamesLoaded })
    : null;
  const resolver = gate.resolver_id ? memberLookup(memberNames, gate.resolver_id, tc, { loaded: memberNamesLoaded }) : null;
  // [SID:4286 · 유나 결정 3] 이름이 줄을 만드는 자리(요청자 · 처리자 줄)는 불러오는 중에도 줄을 그리고 이름만 자리표시(아래가 밀리지 않게).
  const nameSkeleton = <Skeleton as="span" variant="text" className="h-3 w-20 align-middle" aria-hidden />;
  // story #3258(customer-zero 2차) AC1 — doc 결재 카드도 결정 재료(요약)를 body에 실어야
  // «채팅 밖으로 안 나가고 결정 끝나는» 계약을 만족한다(decisionQuestion과 동일 원칙,
  // doc.py transition_doc()이 심은 gate.neutral_facts.doc_summary 그대로 no-fiction 렌더).
  const docSummary = gate.work_item_type === 'doc' && typeof gate.neutral_facts?.['doc_summary'] === 'string'
    && (gate.neutral_facts['doc_summary'] as string).length > 0
    ? (gate.neutral_facts['doc_summary'] as string) : null;

  // story #3263(지원v1·5에스컬레이션) AC1 — 페드루 PO 조건② "카드 본문에 요약·org·reason이
  // 실물로 실려야" — docSummary/decisionQuestion과 동일 원칙(no-fiction, neutral_facts에
  // 실린 값만 그대로). support_gateway_token.py::receive_escalation_event가 심은 필드.
  const isEscalationGate = gate.work_item_type === 'support_escalation';
  const escalationOrgName = isEscalationGate && typeof gate.neutral_facts?.['customer_org_name'] === 'string'
    ? (gate.neutral_facts['customer_org_name'] as string) : null;
  const escalationSummary = isEscalationGate && typeof gate.neutral_facts?.['conversation_summary'] === 'string'
    ? (gate.neutral_facts['conversation_summary'] as string) : null;
  const escalationDetail = isEscalationGate && typeof gate.neutral_facts?.['detail'] === 'string'
    ? (gate.neutral_facts['detail'] as string) : null;
  const escalationReason = isEscalationGate && typeof gate.neutral_facts?.['reason'] === 'string'
    ? (gate.neutral_facts['reason'] as string) : null;

  // story 4887 (UI-4 P4-c) — the card is the ds ApprovalCard (a presentational part); every gate fetch, signature flow, undo, delegate, toss and discuss below is the same code as before and only feeds its slots.
  const resolution: ApprovalResolution = (['approved', 'rejected', 'auto_passed', 'held', 'voided', 'expired'] as const).includes(gate.status as ApprovalResolution)
    ? gate.status as ApprovalResolution
    : 'voided'; // an unmapped status keeps its raw word as the label (nothing invented) with the neutral icon
  const pending = gate.status === 'pending';
  const riskBadge = pending && (riskLevel === 'high' || riskLevel === 'unknown')
    ? { level: riskLevel, label: riskLevel === 'high' ? tCage('riskHigh') : tCage('riskUnknown') }
    : undefined;
  const discussNotice = pending && discussionRequested
    // [SID:4286] 요청자 이름을 불러오는 중이면 이름 없는 배너 문구로 선다(id 조각 0).
    ? (needsDiscussRequesterName && discussRequester !== null
      ? t(discussRequester.fallback ? 'approvalRequestDiscussionRequestedByFallback' : 'approvalRequestDiscussionRequestedBy', {
        name: discussRequester.label,
        josa: pickIGaJosa(discussRequester.label),
        reason: discussionRequested.reason,
      })
      : t('approvalRequestDiscussionRequestedBanner', { reason: discussionRequested.reason }))
    : undefined;
  const waitingOnText = designatedApprover === null
    ? <Skeleton as="span" variant="text" className="h-3 w-28" aria-hidden />
    : t(designatedApprover.fallback ? 'approvalRequestWaitingOnFallback' : 'approvalRequestWaitingOn', { name: designatedApprover.label });
  const tossButton = (
    <DsButton type="button" variant="quiet" onClick={() => setTossOpen(true)} iconStart={<Forward className="h-3.5 w-3.5" aria-hidden />}>
      {t('approvalRequestTossTrigger')}
    </DsButton>
  );

  // the decision material (summary · question · options · assumption · escalation · the resolved template's own blocks) goes in the card's body
  const material = (
    <div className="flex min-w-0 flex-col gap-1.5">
      {docDiff ? (
        <p data-testid="approval-doc-diff" className="font-mono text-ds-mono-md text-ds-ink-3">diff +{docDiff.add} / −{docDiff.del}</p>
      ) : null}
      {docSummary ? <p>{docSummary}</p> : null}
      {/* story #3263 — support escalation ticket draft: org · reason · detail · summary, only the values that exist (no-fiction) */}
      {isEscalationGate ? (
        <div className="flex min-w-0 flex-col gap-1">
          {escalationOrgName ? <p className="font-medium">{t('approvalRequestEscalationOrg', { orgName: escalationOrgName })}</p> : null}
          {escalationReason ? <p className="text-ds-small text-ds-ink-2">{t('approvalRequestEscalationReason', { reason: escalationReason })}</p> : null}
          {escalationDetail ? <p>{escalationDetail}</p> : null}
          {escalationSummary ? <p className="text-ds-small text-ds-ink-2 [white-space:pre-wrap]">{escalationSummary}</p> : null}
        </div>
      ) : null}
      {/* story #3151 — the full question, the options, the assumption; a field that is not in neutral_facts is not drawn */}
      {decisionQuestion ? (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium">{decisionQuestion}</p>
          {decisionOptions.length > 0 ? (
            <ul className="flex flex-col gap-0.5 pl-4">
              {decisionOptions.map((opt, i) => (
                <li key={i} className="list-disc">{opt}</li>
              ))}
            </ul>
          ) : null}
          {decisionAssumption ? <p className="text-ds-small text-ds-ink-2">{t('approvalRequestAssumption', { assumption: decisionAssumption })}</p> : null}
        </div>
      ) : null}
      {/* story #2637 AC4 — the resolved card consumes the verdict template's static blocks (text · fields): the target chip and the reason */}
      {!pending && resolvedStaticBlocks ? (
        <div className="flex min-w-0 flex-col gap-1">
          {resolvedStaticBlocks.filter((b) => b.type === 'text').map((b, i) => renderStaticEventBlock(b, i, gateProjectHref))}
          {resolvedStaticBlocks.filter((b) => b.type === 'fields').map((b, i) => renderStaticEventBlock(b, i, gateProjectHref))}
        </div>
      ) : null}
    </div>
  );
  const hasMaterial = !!(docDiff || docSummary || isEscalationGate || decisionQuestion || (!pending && resolvedStaticBlocks));

  // the decision gate keeps its «요청자» line (story #3151); other gates never drew one
  const requesterLine = decisionQuestion && requesterId
    ? (requester ? t('approvalRequestRequestedBy', { name: requester.label }) : nameSkeleton)
    : undefined;

  let state: ApprovalState;
  let simplePathError: string | null = null;
  if (!pending) {
    state = {
      kind: 'resolved',
      resolution,
      // with the template the sentence lives in the template's text block below; the part's own line is the short verdict (icon + words)
      statusLabel: resolvedStaticBlocks ? verdictLabel : t('approvalRequestResolvedStatus', { status: verdictLabel }),
      // 「남이 처리」 only — 「내가 처리」 needs no name (story #3084)
      by: gate.resolver_id && gate.resolver_id !== currentTeamMemberId
        ? (resolver
          ? tCage(resolver.fallback ? 'gateDetailResolvedByStatusFallback' : 'gateDetailResolvedByStatus', {
            name: resolver.label,
            josa: pickIGaJosa(resolver.label),
            status: verdictLabel,
          })
          : nameSkeleton)
        : undefined,
      // story #2624 — the reason is never lost; with the template it is one of the template's fields (drawn in the material)
      note: !resolvedStaticBlocks && gate.resolution_note ? t('approvalRequestResolutionNote', { note: gate.resolution_note }) : undefined,
      // story #2631 — the 5-minute undo of one's own mistaken decision
      extra: isUndoEligible(gate, currentTeamMemberId) ? <GateUndoButton gateId={gate.id} onUndone={onUndone} compact /> : undefined,
    };
  } else if (isRequesterViewer) {
    // story #3084 「대기·requester」 — who we wait for + the toss to another room
    state = { kind: 'pending', view: 'waiting', waitingOn: waitingOnText, action: tossButton };
  } else if (requesterId && hasDesignatedLine && !isDesignatedViewer) {
    // story #3084 「대기·관찰자」 — a third party: no action
    state = { kind: 'pending', view: 'waiting', waitingOn: waitingOnText };
  } else if (isDelegatedAway) {
    // story #3001 — delegated away: read-only, no name invented
    state = { kind: 'pending', view: 'readonly', note: t('approvalRequestDelegatedAway') };
  } else if (!canAct) {
    // story #2091 fail-closed — no right to decide: no action. A designated viewer still keeps the toss (story #3084), so that case reads as «waiting» with the toss as its one action.
    state = canToss && isDesignatedViewer
      ? { kind: 'pending', view: 'waiting', waitingOn: tCage('gateReadonlyNotAuthorized'), action: tossButton }
      : { kind: 'pending', view: 'readonly', note: tCage('gateReadonlyNotAuthorized') };
  } else {
    const extraNodes = [
      // story #3084 — the toss entry of the designated person, whether or not they judge
      canToss && isDesignatedViewer ? <span key="toss">{tossButton}</span> : null,
      // story #3001 — delegating (bouncing) is a separate axis from the evidence gate
      canDelegate ? <span key="delegate"><DelegateApprovalControl gateId={gate.id} onDelegated={onUndone} /></span> : null,
    ].filter(Boolean);
    // the two extras sit in one small left-aligned row (not full-width stacked buttons)
    const extras = extraNodes.length > 0 ? <div className="flex flex-wrap items-center gap-1" data-testid="approval-extras">{extraNodes}</div> : null;
    if (needsFullFlow || rejectPanelOpen || signPanelOpen) {
      state = {
        kind: 'pending',
        view: 'act',
        needsHandLabel: t('approvalRequestNeedsHand'),
        actions: (
          <>
            <GateSignatureApproval
              // story #2975 — the key resets the evidence check / reason when the head SHA (or the recipe draft version, story #4190) changes under the card
              key={`${gate.id}:${gate.github_check_run_sha ?? ''}:${reviewedDraftOf(gate)?.version ?? ''}`}
              gate={gate}
              resolving={resolving}
              error={transitionError}
              // story #2027 AC2 — reaching this callback IS the evidence confirmation (the panel blocks the button until the evidence is viewed and a reason is given)
              onApprove={(reason) => onApprove(reason, true)}
              onReject={onReject}
              onDiscuss={onDiscuss}
              compact
              // story #3334 / #4370 — a low-risk gate enters this panel only by «변경 요청» and may leave it (the cancel also clears the reason draft); a high-risk gate has no other path
              onCancel={!needsFullFlow ? () => { setRejectPanelOpen(false); setSignPanelOpen(false); } : undefined}
            />
            {extras}
          </>
        ),
      };
    } else {
      simplePathError = transitionError;
      state = {
        kind: 'pending',
        view: 'act',
        needsHandLabel: t('approvalRequestNeedsHand'),
        actions: (
          <>
            {/* story #4190 — a recipe-publish gate is not approved in one tap: it opens the signature panel with the draft card («초안 보고 승인») */}
            <ApprovalActions
              approveLabel={isRecipePublishGate(gate) ? tCage('gateReviewDraftToApprove') : tCage('gateApprove')}
              rejectLabel={tCage('gateReject')}
              onApprove={() => { if (isRecipePublishGate(gate)) setSignPanelOpen(true); else void onApprove(); }}
              onReject={() => setRejectPanelOpen(true)}
              disabled={resolving}
            >
              {/* story #2631 — 「보류(논의 필요)」: the low-risk path has no reason box, so a dialog */}
              <DsButton type="button" variant="quiet" onClick={onDiscussClick} disabled={resolving}>
                {tCage('gateDiscussSubmit')}
              </DsButton>
            </ApprovalActions>
            {extras}
          </>
        ),
      };
    }
  }

  return (
    <>
      <ApprovalCard
        label={t('approvalRequestLabel')}
        title={title}
        onTitleClick={onTitleClick}
        requester={requesterLine}
        risk={riskBadge}
        notice={discussNotice}
        error={simplePathError ? tCage('gateTransitionError', { reason: simplePathError }) : undefined}
        state={state}
      >
        {hasMaterial ? material : null}
      </ApprovalCard>
      {canToss && projectId ? (
        <TossSheet
          open={tossOpen}
          onOpenChange={setTossOpen}
          gateId={gate.id}
          projectId={projectId}
          currentTeamMemberId={currentTeamMemberId ?? ''}
          designatedApproverId={gate.designated_approver_id ?? ''}
          designatedApproverName={designatedApproverName}
          designatedApproverFallback={designatedApprover?.fallback ?? false}
          onTossed={(conversationTitle, inserted) => {
            addToast({
              type: 'info',
              title: inserted
                ? t('approvalRequestTossSuccessToast', { conversation: conversationTitle })
                : t('approvalRequestTossAlreadyThereToast', { conversation: conversationTitle }),
            });
            onUndone();
          }}
          onAlreadyResolved={() => {
            addToast({ type: 'warning', title: tCage('gateAlreadyResolvedError') });
            onUndone();
          }}
        />
      ) : null}
    </>
  );
}

function DelegateApprovalControl({ gateId, onDelegated }: { gateId: string; onDelegated: () => void }) {
  const t = useTranslations('chats');
  const tc = useTranslations('common');
  const { currentTeamMemberId } = useDashboardContext();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<SelectOption[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [selected, setSelected] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // story #3040 v3 — 동명 표시이름 오지정 실사고(선생님 실계정 vs PO 대행 계정, 둘 다
  // "송윤재") 재발 방지. AC2: 동명이 실재할 때만 경고(음성 대조 — 비동명 org는 항상 false).
  const [hasDuplicateNames, setHasDuplicateNames] = useState(false);

  const openPicker = async () => {
    setOpen(true);
    setError(null);
    if (members.length > 0) return;
    setLoadingMembers(true);
    try {
      // story #3231 2라운드(카디르 QA) — /api/org-members가 admin 전용 403으로 잠기면서
      // 일반 Member의 이 위임 픽커도 doc-gate-section.tsx와 동일하게 후보 0명으로
      // 파손됐다. 결재자 지정 전용 엔드포인트로 교체(원 org-members roster는 안 건드림)
      // + res.ok 미확인(403이어도 조용히 빈 배열로 저하되던 결함)도 같이 고친다.
      const res = await fetchWithAuth('/api/org-members/eligible-approvers');
      if (!res.ok) {
        setError(t('hitlSendFailed'));
        return;
      }
      const json = await res.json().catch(() => null) as {
        data?: Array<{ id: string; user_id: string | null; name?: string | null; email?: string | null; role: 'owner' | 'admin' | 'member' }>;
      } | null;
      // story #3001 하드닝(PO 확定) — 위임 대상 자격은 BE가 400으로 최종 강제하지만(owner/admin
      // fresh 조회), 여기서도 같은 축(owner/admin·본인 제외)으로 미리 좁혀 자격 밖 클릭 자체를
      // 줄인다(지어낸 자격 판단이 아니라 BE와 같은 규칙 재사용 — org-members-section.tsx와 동형).
      // story #3040 v3 — label 산출(이메일 병기)·동명 경고 판정은 doc-gate-section.tsx와
      // 동일 소스(buildApproverPickerOptions)로 통일 — 지정 표면 두 곳이 갈리지 않게.
      const { options, hasDuplicateNames: dup } = buildApproverPickerOptions(json?.data ?? [], currentTeamMemberId, { unnamed: tc('memberUnnamed') });
      setMembers(options);
      setHasDuplicateNames(dup);
    } catch {
      setError(t('hitlSendFailed'));
    } finally {
      setLoadingMembers(false);
    }
  };

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/gates/${gateId}/delegate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_approver_member_id: selected }),
      });
      if (res.ok) { setOpen(false); onDelegated(); return; }
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? `HTTP ${res.status}`);
    } catch {
      setError(t('hitlSendFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <DsButton type="button" variant="quiet" onClick={() => void openPicker()}>
        {t('approvalRequestDelegate')}
      </DsButton>
    );
  }

  return (
    <div className="space-y-1.5">
      {error ? <p role="alert" aria-live="assertive" className="text-editorial-meta text-foreground">{error}</p> : null}
      {/* story #3040 v3 AC2 — 동명 표시이름이 실재할 때만(음성 대조: 비동명 org는 렌더 0). */}
      {hasDuplicateNames ? (
        <p role="alert" className="text-editorial-meta text-warning-strong">{t('approvalRequestDelegateDuplicateWarning')}</p>
      ) : null}
      <OperatorDropdownSelect
        value={selected}
        onValueChange={setSelected}
        options={members}
        placeholder={loadingMembers ? t('approvalRequestDelegateLoading') : t('approvalRequestDelegatePickPlaceholder')}
        disabled={loadingMembers || submitting}
      />
      <div className="flex gap-1.5">
        <Button type="button" size="sm" onClick={() => void submit()} disabled={!selected || submitting} className="flex-1">
          {t('approvalRequestDelegateConfirm')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={submitting} className="flex-1">
          {t('approvalRequestDelegateCancel')}
        </Button>
      </div>
    </div>
  );
}
