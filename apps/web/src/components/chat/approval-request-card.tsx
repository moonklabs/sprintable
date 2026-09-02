'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, FileText, Forward, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { OperatorDropdownSelect, type SelectOption } from '@/components/ui/operator-dropdown-select';
import { GateSignatureApproval } from '@/components/cage/gate-signature-approval';
import { GateUndoButton, isUndoEligible } from '@/components/cage/gate-undo-button';
import { GateDiscussDialog } from '@/components/cage/gate-discuss-dialog';
import { deriveRiskLevel, usesSignatureFlow, deriveGateProofState } from '@/components/cage/gate-risk';
import { EntityPreviewModal, canPreviewEntity, getEntityHref } from '@/components/chat/embed-card';
import { useReadingPanel } from '@/components/chat/reading-panel-context';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem } from '@/components/kanban/types';
import { parseBlockTemplate, renderBlockTemplate, type EventDefinitionSummary } from '@/lib/block-template';
import { renderStaticEventBlock } from '@/components/chat/event-block-card';
import { ProofCapsule } from '@/components/proof-capsule/proof-capsule';
import { useSseMultiplexerContext } from '@/components/realtime-provider';

import { escapeMarkdownLinkText } from '@/components/chat/chat-input-entity-tokens';
import { fetchWithAuth } from '@/lib/db/client';
import { buildApproverPickerOptions } from '@/lib/approver-picker-options';
import { useToast, ToastContainer } from '@/components/ui/toast';
import { TossSheet } from '@/components/chat/toss-sheet';

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
  const t = useTranslations('chats');
  // story #2926(P0-F 잔여 fast-follow, 카디르 F2 QA LOW①) — 아래 stateLabel 유도가
  // deriveGateProofState()의 통일 키(gateStatus*)를 쓴다 — 그 키들은 'cage' 네임스페이스.
  const tCage = useTranslations('cage');
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
  const { toasts, addToast, dismissToast } = useToast();

  const fetchGate = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/gates/${target.gate_id}`);
      if (res.status === 404) { setState({ kind: 'not-found' }); return; }
      if (!res.ok) { setState({ kind: 'error' }); return; }
      const json = await res.json().catch(() => null) as { data?: GateItem } | GateItem | null;
      const gate = (json && 'data' in json ? json.data : json) as GateItem | undefined;
      if (!gate) { setState({ kind: 'error' }); return; }
      setState({ kind: 'ready', gate });
    } catch {
      setState({ kind: 'error' });
    }
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

  const transition = async (status: 'approved' | 'rejected', note?: string, evidenceViewed?: boolean) => {
    setResolving(true);
    setTransitionError(null);
    try {
      const res = await fetchWithAuth(`/api/gates/${target.gate_id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // story #2027 AC2 — gates/[id]/page.tsx와 동일 계약(evidence_viewed는 고위험 서명
        // 플로우 onApprove에서만 true로 실린다, 아래 ApprovalRequestBody 배선 참조).
        // story #2975 회귀 자체발견(#2982 작업 중) — reviewed_head_sha 누락(gates/[id]/
        // page.tsx만 #2975에서 고쳐지고 이 챗 카드는 빠져 있었다). known SHA 있는 merge
        // 게이트를 이 카드에서 승인하면 #3410 착지 後 항상 409(gate_head_changed)로
        // 거부되는 라이브 회귀 — state.gate(fetchGate 실측)에서 채운다.
        body: JSON.stringify({
          status, note: note?.trim() || null, evidence_viewed: evidenceViewed ?? false,
          reviewed_head_sha: state.kind === 'ready' ? (state.gate.github_check_run_sha ?? null) : null,
        }),
      });
      if (res.ok) { await fetchGate(); return; }
      const body = await res.json().catch(() => null) as { error?: { message?: string; code?: string } } | null;
      const code = body?.error?.code;
      // story #2975·#2982(PO 확定) — code 부착 거부는 raw BE 문구(한국어 평문) 대신 사람
      // 문구로 매핑(gates/[id]/page.tsx와 동형). 둘 다 "화면이 아는 상태가 서버와
      // 어긋났다"는 뜻이라 재조회로 실제 현재 상태를 반영(AC1 — 죽은 버튼이 다시 안 뜬다).
      if (code === 'gate_head_changed' || code === 'gate_already_resolved') {
        await fetchGate();
      }
      setTransitionError(
        code === 'gate_head_changed' ? tCage('gateHeadChangedError')
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
  const discuss = async (reason: string) => {
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
        return;
      }
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setDiscussError(body?.error?.message ?? `HTTP ${res.status}`);
    } catch {
      setDiscussError(t('hitlSendFailed'));
    } finally {
      setDiscussSubmitting(false);
    }
  };

  // story #2926(P0-F F1) — loading/not-found/error는 claim(제목)이 아직 없는 과도 상태라
  // Proof Capsule 셸을 억지로 씌우지 않는다(claim이 빈 이야기를 지어내는 게 되므로) — 기존
  // 가벼운 placeholder 그대로 유지. AC1(3서피스 단일 ProofCapsule 소비)의 대상은 실 데이터가
  // 있는 'ready' 상태다.
  if (state.kind !== 'ready') {
    return (
      <div className="min-w-0 max-w-full rounded-xl rounded-tl-sm border border-border bg-card px-3.5 py-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-foreground">
          <FileText className="h-3 w-3" aria-hidden />
          {t('approvalRequestLabel')}
        </div>
        {state.kind === 'loading' ? (
          <div className="h-8 animate-pulse rounded-lg bg-muted" />
        ) : state.kind === 'not-found' ? (
          <p className="text-xs text-muted-foreground">{t('approvalRequestNotFound')}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('approvalRequestLoadError')}</p>
        )}
      </div>
    );
  }

  const gate = state.gate;
  const title = gate.work_item_summary?.title ?? `#${gate.work_item_id.slice(0, 8)}`;
  const previewEntityType = toEntityType(gate.work_item_type);
  const canPreview = canPreviewEntity(previewEntityType);
  // story #2926(P0-F 잔여 fast-follow, 카디르 F2 QA LOW①·② 처방) — F1/F2/F3 3곳 중복 판정
  // 로직을 gate-risk.ts의 deriveGateProofState()로 승격, stateLabel 문구도 'cage' 네임스페이스
  // 통일 키로 수렴(F1↔F2 held/approved 문구 불일치 해소). 매핑 안 된 값은 원문 그대로(지어내지
  // 않음, 기존 관례 유지).
  const { proofState, statusKey } = deriveGateProofState(gate.status);
  const stateLabel = statusKey ? tCage(statusKey) : gate.status;
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

  return (
    <>
      <ProofCapsule
        density="card"
        proofState={proofState}
        stateLabel={stateLabel}
        claim={title}
        evidence={docDiff ? { diff: docDiff } : undefined}
        onClaimClick={canPreview ? () => {
          if (readingPanel) {
            readingPanel.open({
              kind: 'entity', entityType: previewEntityType, entityId: gate.work_item_id,
              title, status: null, href: getEntityHref(previewEntityType, gate.work_item_id),
            });
            return;
          }
          setShowPreview(true);
        } : undefined}
        className="max-w-full"
        footer={
          <ApprovalRequestBody
            gate={gate}
            resolving={resolving}
            transitionError={transitionError}
            onApprove={(reason, evidenceViewed) => void transition('approved', reason, evidenceViewed)}
            onReject={(reason) => void transition('rejected', reason)}
            onDiscuss={(reason) => void discuss(reason)}
            onDiscussClick={() => setDiscussDialogOpen(true)}
            onUndone={() => void fetchGate()}
            eventDefinitionsByKey={eventDefinitionsByKey}
            addToast={addToast}
          />
        }
      />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      <GateDiscussDialog
        open={discussDialogOpen}
        onOpenChange={setDiscussDialogOpen}
        onSubmit={(reason) => void discuss(reason)}
        submitting={discussSubmitting}
        error={discussError}
      />
      {!readingPanel && showPreview && (
        <EntityPreviewModal
          entityType={previewEntityType}
          entityId={gate.work_item_id}
          title={title}
          status={null}
          href={getEntityHref(previewEntityType, gate.work_item_id)}
          onClose={() => setShowPreview(false)}
        />
      )}
    </>
  );
}

function ApprovalRequestBody({
  gate, resolving, transitionError, onApprove, onReject, onDiscuss, onDiscussClick, onUndone, eventDefinitionsByKey,
  addToast,
}: {
  gate: GateItem;
  resolving: boolean;
  transitionError: string | null;
  onApprove: (reason?: string, evidenceViewed?: boolean) => void;
  onReject: (reason?: string) => void;
  /** story #2631 — 고위험(서명) 플로우가 이미 가진 사유 필드를 그대로 재사용해 직접 제출. */
  onDiscuss: (reason: string) => void;
  /** story #2631 — 저위험 플로우엔 사유 입력창이 없어 별도 다이얼로그를 연다. */
  onDiscussClick: () => void;
  onUndone: () => void;
  eventDefinitionsByKey?: Record<string, EventDefinitionSummary> | null;
  /** story #3084(층3) — 토스 성공/409 안내 토스트(카드 인스턴스가 소유한 useToast, 부모가 전달). */
  addToast: (toast: { type?: 'info' | 'warning' | 'success' | 'error'; title: string; body?: string }) => void;
}) {
  const t = useTranslations('chats');
  // gates/[id]/page.tsx와 같은 문구를 쓴다(동일 개념=동일 어휘, DS 원칙) — 그 키들은 'cage'
  // 네임스페이스에 있다('chats'엔 없음, 그라운딩 중 확認).
  const tCage = useTranslations('cage');
  const { currentTeamMemberId, projectId } = useDashboardContext();
  const title = gate.work_item_summary?.title ?? `#${gate.work_item_id.slice(0, 8)}`;

  // story #3084(2026-08-25, 유나 픽셀 규격 v1 §부록A — 상태 파생표 SSOT) — «대기·requester»/
  // «대기·관찰자»/토스 시트 문구가 필요로 하는 이름 2종(designated_approver_id·resolver_id)을
  // gates/[id]/page.tsx의 fetchedResolverIdRef 관례와 동형으로 지연 조회한다(카드마다 독립
  // — DelegateApprovalControl의 openPicker on-demand 조회와 같은 결).
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
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
    void fetchWithAuth('/api/team-members')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: { id: string; name: string }[] } | null) => {
        if (!json?.data) return;
        const names: Record<string, string> = {};
        for (const m of json.data) names[m.id] = m.name;
        setMemberNames((prev) => ({ ...prev, ...names }));
      })
      .catch(() => { /* non-critical — id 스니펫 폴백으로 graceful */ });
  }, [needsDesignatedName, needsResolverName, needsRequesterName, needsDiscussRequesterName, gate.designated_approver_id, gate.resolver_id, requesterId, discussionRequested?.requestedByMemberId]);
  const designatedApproverName = gate.designated_approver_id
    ? memberNames[gate.designated_approver_id] ?? gate.designated_approver_id.slice(0, 8)
    : null;

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
  const resolvedStaticBlocks = gate.status !== 'pending' ? (() => {
    const definition = eventDefinitionsByKey?.['preset.gate.verdict'];
    const parsed = definition?.block_template ? parseBlockTemplate(definition.block_template) : null;
    if (!parsed) return null;
    const verdictLabel = RESOLVED_STATUS_LABEL_KEYS[gate.status] ? t(RESOLVED_STATUS_LABEL_KEYS[gate.status]!) : gate.status;
    const payload: Record<string, unknown> = {
      gate_type: gate.gate_type,
      verdict: verdictLabel,
      resolution_note: gate.resolution_note ?? null,
    };
    // story #3332 — 0301 마이그가 preset.gate.verdict의 "대상" 필드를 {{payload.
    // work_item_title}}(생 텍스트, payload_schema엔 있었으나 아무 발행처도 채운 적 없어
    // 항상 ⟨missing⟩이었다)에서 {{ref.work_item}}(클릭 토큰)로 바꿨다. 이 카드는 서버가
    // 계산해 주는 refs를 못 받으므로(자체 fetchGate() 데이터로 합성하는 카드) 여기서
    // 직접 만든다 — title은 이 컴포넌트가 이미 쓰는 값(work_item_summary?.title 폴백
    // 포함) 그대로, escapeMarkdownLinkText는 BE build_reference_token과 동일 escape
    // 규칙(reference_token.py)의 FE 미러(chat-input-entity-tokens.ts) 재사용.
    const refs: Record<string, string | null> = {
      work_item: `[${escapeMarkdownLinkText(title)}](entity:${toEntityType(gate.work_item_type)}:${gate.work_item_id})`,
    };
    // PO 리뷰(head 81f7e4a7e) — resolution_note 없음은 템플릿 저자 실수(⟨missing⟩ 마커
    // 대상)가 아니라 정상적인 「선택값 부재」다(기존 카드도 사유 없으면 그 줄 자체를 안
    // 그렸다 — story #2624). fields 블록에서 payload.resolution_note를 참조하는 항목을
    // 렌더 *전에* 통째로 걸러내 ⟨missing⟩ 마커가 아예 뜨지 않게 한다(사유가 있을 땐 그대로
    // 통과 — filter는 no-op).
    const blocksToRender = gate.resolution_note
      ? parsed.blocks
      : parsed.blocks.map((b) => (
        b.type === 'fields' ? { ...b, fields: b.fields.filter((f) => f.value !== '{{payload.resolution_note}}') } : b
      ));
    return renderBlockTemplate({ blocks: blocksToRender }, payload, refs).filter((b) => b.type === 'text' || b.type === 'fields');
  })() : null;
  const riskLevel = deriveRiskLevel(gate);
  const needsFullFlow = usesSignatureFlow(riskLevel);
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
  const requesterName = requesterId ? (memberNames[requesterId] ?? requesterId.slice(0, 8)) : null;
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

  return (
    <div className="space-y-2">
      {/* story #2926(P0-F F1) — 제목(claim)·미리보기 진입점·EntityPreviewModal은 이제 바깥
          ApprovalRequestCard의 ProofCapsule 셸이 소유한다(claim=onClaimClick). 이 body는
          claim 아래의 실 기능(위험 배지·서명 플로우·회신 상태·액션 버튼)만 담당. */}
      {gate.status === 'pending' && (riskLevel === 'high' || riskLevel === 'unknown') ? (
        <Badge variant={riskLevel === 'high' ? 'warning' : 'outline'} className={riskLevel === 'unknown' ? 'text-muted-foreground' : undefined}>
          {riskLevel === 'high' ? tCage('riskHigh') : tCage('riskUnknown')}
        </Badge>
      ) : null}

      {/* story #3258(customer-zero 2차) AC1 — doc 결재 카드 요약. decisionQuestion과 형제
          블록(같은 스타일, 다른 work_item_type). */}
      {docSummary ? (
        <div className="min-w-0 rounded-lg border border-border bg-muted/40 p-2 text-xs text-foreground [overflow-wrap:anywhere]">
          {docSummary}
        </div>
      ) : null}

      {/* story #3263(지원v1·5에스컬레이션) AC1 — 고객 지원 에스컬레이션 티켓 초안. 페드루 PO
          조건② "카드 본문에 요약·org·reason이 실물로 실려야"(스텁 금지) — docSummary와
          동일 원칙, no-fiction(support_gateway_token.py::receive_escalation_event가 심은
          값만 그대로). 고객 개인정보는
          org명만(PO 확定, PII 0) — escalation_id는 상세 추적용(사람이 직접 읽는 정보 아님,
          카드엔 안 보임). */}
      {isEscalationGate ? (
        <div className="min-w-0 space-y-1 rounded-lg border border-border bg-muted/40 p-2 [overflow-wrap:anywhere]">
          {escalationOrgName ? (
            <p className="text-xs font-medium text-foreground">{t('approvalRequestEscalationOrg', { orgName: escalationOrgName })}</p>
          ) : null}
          {escalationReason ? (
            <p className="text-[11px] text-muted-foreground">{t('approvalRequestEscalationReason', { reason: escalationReason })}</p>
          ) : null}
          {escalationDetail ? (
            <p className="text-xs text-foreground">{escalationDetail}</p>
          ) : null}
          {escalationSummary ? (
            <p className="text-[11px] text-muted-foreground [white-space:pre-wrap]">{escalationSummary}</p>
          ) : null}
        </div>
      ) : null}

      {/* story #3151 — 결정 재료(질문 전문·선택지·요청자). no-fiction: neutral_facts에 실린
          값만 그대로 보이고, 없는 필드(assumption 등)는 그 줄 자체를 안 그린다. */}
      {decisionQuestion ? (
        <div className="min-w-0 space-y-1 rounded-lg border border-border bg-muted/40 p-2 [overflow-wrap:anywhere]">
          <p className="text-xs font-medium text-foreground">{decisionQuestion}</p>
          {decisionOptions.length > 0 ? (
            <ul className="space-y-0.5 pl-3 text-xs text-foreground">
              {decisionOptions.map((opt, i) => (
                <li key={i} className="list-disc">{opt}</li>
              ))}
            </ul>
          ) : null}
          {decisionAssumption ? (
            <p className="text-[11px] text-muted-foreground">{t('approvalRequestAssumption', { assumption: decisionAssumption })}</p>
          ) : null}
          {requesterName ? (
            <p className="text-[11px] text-muted-foreground">{t('approvalRequestRequestedBy', { name: requesterName })}</p>
          ) : null}
        </div>
      ) : null}

      {/* story #3258(customer-zero 2차) — 논의 요청 성공을 알리는 유일한 지속 신호. 토스트는
          그 순간을 놓치면 사라지지만, 이 배너는 fetchGate() 재조회 때마다(재마운트·재오픈 포함)
          그대로 남아 "이미 요청했다"는 사실을 재확인시킨다 — 3연발 클릭의 근본 처방. */}
      {gate.status === 'pending' && discussionRequested ? (
        <div className="min-w-0 rounded-lg border border-warning/30 bg-warning/8 p-2 [overflow-wrap:anywhere]">
          <p className="text-[11px] font-medium text-warning-strong">
            {needsDiscussRequesterName
              ? t('approvalRequestDiscussionRequestedBy', {
                name: memberNames[discussionRequested.requestedByMemberId!] ?? discussionRequested.requestedByMemberId!.slice(0, 8),
                reason: discussionRequested.reason,
              })
              : t('approvalRequestDiscussionRequestedBanner', { reason: discussionRequested.reason })}
          </p>
        </div>
      ) : null}

      {gate.status !== 'pending' ? (
        <>
          {resolvedStaticBlocks ? (
            // story #2637 AC4 — 아이콘은 그대로 뱃지처럼 앞에 두고(어휘 4종 밖의 순수 UI 크롬,
            // 템플릿이 대신할 수 없다), text·fields 블록은 EventBlockCard와 동일한 자기 고유
            // 크기(text-sm/text-xs)로 그대로 둔다 — 억지로 기존 text-xs 한 줄에 욱여넣지 않는다
            // (사이즈 클래스 충돌로 인한 시각 왜곡 방지).
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                {gate.status === 'approved' ? <Check className="h-3.5 w-3.5 text-primary" /> : <X className="h-3.5 w-3.5 text-destructive" />}
                {resolvedStaticBlocks.filter((b) => b.type === 'text').map((b, i) => renderStaticEventBlock(b, i))}
              </div>
              {resolvedStaticBlocks.filter((b) => b.type === 'fields').map((b, i) => renderStaticEventBlock(b, i))}
            </div>
          ) : (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                {gate.status === 'approved' ? <Check className="h-3.5 w-3.5 text-primary" /> : <X className="h-3.5 w-3.5 text-destructive" />}
                {t('approvalRequestResolvedStatus', {
                  status: RESOLVED_STATUS_LABEL_KEYS[gate.status] ? t(RESOLVED_STATUS_LABEL_KEYS[gate.status]!) : gate.status,
                })}
              </div>
              {/* story #2624 — 상신자가 결과를 회신 카드로 받아도 사유(resolution_note)가 안
                  보이면 "사유는 남겨놨는데" 인시던트가 human 웹 표면에서 재발한다. gate는 항상
                  fetchGate()로 실측한 최신 값이라 어느 메시지(request/result)를 눌러 들어왔든
                  같은 값을 보여준다.
                  story #2637 AC4 — 템플릿 없음/파싱실패 시 폴백(비회귀 안전망, AC2와 동형). */}
              {/* story #3084(2026-08-25, 유나 픽셀 규격 부록A) — 「남이 처리」 상태만 처리자
                  이름 표기(「내가 처리」는 굳이 이름을 안 붙여도 자명 — 상태 어휘표 그대로).
                  gates/[id]/page.tsx의 gateDetailResolvedByStatus를 그대로 재사용(동일 개념=
                  동일 어휘, DS 원칙 — 새 키 안 만듦). */}
              {gate.resolver_id && gate.resolver_id !== currentTeamMemberId ? (
                <p className="text-[11px] text-muted-foreground">
                  {tCage('gateDetailResolvedByStatus', {
                    name: memberNames[gate.resolver_id] ?? gate.resolver_id.slice(0, 8),
                    status: RESOLVED_STATUS_LABEL_KEYS[gate.status] ? t(RESOLVED_STATUS_LABEL_KEYS[gate.status]!) : gate.status,
                  })}
                </p>
              ) : null}
              {gate.resolution_note ? (
                <p className="text-[11px] text-muted-foreground">{t('approvalRequestResolutionNote', { note: gate.resolution_note })}</p>
              ) : null}
            </div>
          )}
          {/* story #2631 — 오클릭 정정. 방금 본인이 해소한 게이트만(5분 창) — 두 렌더 분기
              공통으로 하나만 둔다(중복 방지). */}
          {isUndoEligible(gate, currentTeamMemberId) ? (
            <GateUndoButton gateId={gate.id} onUndone={onUndone} compact />
          ) : null}
        </>
      ) : isRequesterViewer ? (
        // story #3084(2026-08-25, 유나 픽셀 규격 부록A) — 「대기·requester」. requesterId를
        // gate.neutral_facts에서 확실히 아는 경우에만(⚠️아래 관찰자 분기와 함께, requesterId가
        // null인 legacy/무기록 게이트는 이 분기 자체가 안 걸려 그대로 isDelegatedAway로
        // 폴백한다 — #3001 당시엔 이 구분이 없었던 것과 동형 안전망, 회귀 0).
        <>
          <div className="flex items-center gap-1.5 text-xs font-medium text-warning-strong">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
            {t('approvalRequestWaitingOn', { name: designatedApproverName ?? '' })}
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={() => setTossOpen(true)} className="w-full">
            {t('approvalRequestTossTrigger')}
          </Button>
        </>
      ) : requesterId && hasDesignatedLine && !isDesignatedViewer ? (
        // story #3084 — 「대기·관찰자」(그룹방 3자). requesterId를 알고 있고 그게 나도 아니고
        // designated도 내가 아닌, 진짜 제3자 시점 — 액션 없음(#3001 delegate와 무관한 축이라
        // "위임됨" 문구는 부정확해 안 쓴다).
        <div className="flex items-center gap-1.5 text-xs font-medium text-warning-strong">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
          {t('approvalRequestWaitingOn', { name: designatedApproverName ?? '' })}
        </div>
      ) : isDelegatedAway ? (
        // story #3001(선생님 정책 확定) — 이 카드의 원 수신자(=지금 보고 있는 나)가 위임으로
        // 밀려났다. "위임됨"은 BE rule A상 여전히 canAct===true로 잡힐 수 있어도(transition
        // authz는 이 스토리 스코프 밖 — designated_approver_id는 카드 배달만 좌우) 화면에서는
        // 무조건 읽기전용으로 좁힌다 — 결정 권한이 여기 남아있는 것처럼 보이는 UI 자체가
        // "승계는 튕겨내기로만" 원칙(선생님)의 시각적 위반이라(누구 이름인지는 지어내지
        // 않는다 — GateResponse가 현재 지정자 이름을 안 실어 보낸다).
        // story #3084 — requesterId를 모르는(legacy/무기록) 게이트의 「대기·requester/관찰자」
        // 판정 불가 케이스도 이 분기로 안전 폴백(위 두 분기가 requesterId 존재를 전제).
        <p className="text-xs text-muted-foreground">{t('approvalRequestDelegatedAway')}</p>
      ) : !canAct ? (
        // story #2091(P0)과 동일 fail-closed 규율 — can_approve=false(무권한 뷰어)는 액션을
        // 렌더하지 않는다. 고위험도 이제 챗 안에서 완결되므로(#2625) 여기 남는 유일한
        // "액션 불가" 사유는 무권한뿐이다.
        <p className="text-[11px] text-muted-foreground">{tCage('gateReadonlyNotAuthorized')}</p>
      ) : needsFullFlow ? (
        // story #2975(유나양 design 판정 2026-08-24) 갭 자체발견(#2982 작업 중) — 그 블로커
        // 처방(key={SHA}로 재조회 後 evidenceViewed/reason 강제 리셋)이 gates/[id]/page.tsx
        // 에만 적용되고 이 챗 카드는 빠져 있었다. 같은 컴포넌트·같은 취약(SHA 바뀐 뒤에도
        // 열람체크가 살아있어 재확認 없이 재승인 가능)이라 동형 처방.
        <GateSignatureApproval
          key={gate.github_check_run_sha}
          gate={gate}
          resolving={resolving}
          error={transitionError}
          // story #2027 AC2: GateSignatureApproval의 canSign이 evidenceViewed&&reason로 버튼을
          // 막아서 이 콜백에 닿았다는 사실 자체가 열람 확인 — gates/[id]/page.tsx와 동일 계약.
          onApprove={(reason) => onApprove(reason, true)}
          onReject={onReject}
          onDiscuss={onDiscuss}
          compact
        />
      ) : (
        <>
          {transitionError ? (
            <p role="alert" aria-live="assertive" className="text-[11px] text-foreground">
              {tCage('gateTransitionError', { reason: transitionError })}
            </p>
          ) : null}
          <div className="flex gap-1.5">
            <Button type="button" size="sm" onClick={() => onApprove()} disabled={resolving} className="flex-1">
              <Check className="h-3.5 w-3.5" aria-hidden />
              {tCage('gateApprove')}
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => onReject()} disabled={resolving} className="flex-1">
              <X className="h-3.5 w-3.5" aria-hidden />
              {tCage('gateReject')}
            </Button>
          </div>
          {/* story #2631 — 「보류(논의 필요)」. 저위험 경로엔 사유 입력창이 없어 다이얼로그로. */}
          <Button type="button" size="sm" variant="ghost" onClick={onDiscussClick} disabled={resolving} className="w-full text-muted-foreground">
            {tCage('gateDiscussSubmit')}
          </Button>
        </>
      )}
      {/* story #3084(층3) — designated 본인의 토스 진입점. 승인/반려 판단 여부와 무관하게
          (서명 고위험 플로우 아래서도) 항상 같은 자리 — 토스는 "판단"이 아니라 "도달 경로
          추가"라 evidence 확인 게이트(needsFullFlow)·delegate와 별개 축. */}
      {canToss && isDesignatedViewer ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => setTossOpen(true)} className="w-full text-muted-foreground">
          <Forward className="h-3.5 w-3.5" aria-hidden />
          {t('approvalRequestTossTrigger')}
        </Button>
      ) : null}
      {/* story #3001 — 위임(튕겨내기). 승인/반려 판단 여부와 무관하게(서명 고위험 플로우
          아래서도) 항상 같은 자리에 둔다 — 위임은 "판단을 남에게 넘기는" 행위라 evidence
          확인 게이트(needsFullFlow)와는 별개 축. */}
      {canDelegate ? <DelegateApprovalControl gateId={gate.id} onDelegated={onUndone} /> : null}
      {canToss && projectId ? (
        <TossSheet
          open={tossOpen}
          onOpenChange={setTossOpen}
          gateId={gate.id}
          projectId={projectId}
          currentTeamMemberId={currentTeamMemberId ?? ''}
          designatedApproverId={gate.designated_approver_id ?? ''}
          designatedApproverName={designatedApproverName}
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
    </div>
  );
}

function DelegateApprovalControl({ gateId, onDelegated }: { gateId: string; onDelegated: () => void }) {
  const t = useTranslations('chats');
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
      const { options, hasDuplicateNames: dup } = buildApproverPickerOptions(json?.data ?? [], currentTeamMemberId);
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
      <Button type="button" size="sm" variant="ghost" onClick={() => void openPicker()} className="w-full text-muted-foreground">
        {t('approvalRequestDelegate')}
      </Button>
    );
  }

  return (
    <div className="space-y-1.5">
      {error ? <p role="alert" aria-live="assertive" className="text-[11px] text-foreground">{error}</p> : null}
      {/* story #3040 v3 AC2 — 동명 표시이름이 실재할 때만(음성 대조: 비동명 org는 렌더 0). */}
      {hasDuplicateNames ? (
        <p role="alert" className="text-[11px] text-warning-strong">{t('approvalRequestDelegateDuplicateWarning')}</p>
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
