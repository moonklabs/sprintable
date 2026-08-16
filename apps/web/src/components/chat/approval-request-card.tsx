'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Eye, FileText, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GateSignatureApproval } from '@/components/cage/gate-signature-approval';
import { GateUndoButton, isUndoEligible } from '@/components/cage/gate-undo-button';
import { GateDiscussDialog } from '@/components/cage/gate-discuss-dialog';
import { deriveRiskLevel, usesSignatureFlow } from '@/components/cage/gate-risk';
import { EntityPreviewModal, getEntityHref, resolveEntityIcon } from '@/components/chat/embed-card';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { GateItem } from '@/components/kanban/types';
import { parseBlockTemplate, renderBlockTemplate, type EventDefinitionSummary } from '@/lib/block-template';
import { renderStaticEventBlock } from '@/components/chat/event-block-card';

import { fetchWithAuth } from '@/lib/db/client';

export interface ApprovalTarget {
  work_item_type: string;
  work_item_id: string;
  gate_id: string;
  /** story #2624 — 결재 "결과" 메시지(message_kind=result, BE #3015)의 approval_target은
   * actions가 없다(액션 카드가 아니라 회신 카드라 승인/반려 선택지 자체가 없음). 이 필드는
   * 이 컴포넌트에서 실제로 읽히지 않는다(gate 상태는 항상 fetchGate()의 실물로 판단) —
   * optional로 둬 두 메시지 종류(request/result) 모두 같은 타입으로 수용한다. */
  actions?: string[];
}

interface ApprovalRequestCardProps {
  target: ApprovalTarget;
  /** story #2637 AC4(PO 08-14 확定) — chat-view.tsx가 대화당 1회 배치조회한 event_definitions
   * 카탈로그를 그대로 물려받는다(eventDefinitionsByKey와 동일 패턴, 별도 fetch 안 만든다).
   * resolved(회신) 분기가 이 카탈로그의 preset.gate.verdict 항목을 찾아 정적 표현부(text·
   * fields)만 소비한다 — pending(요청·서명·버튼) 분기는 그대로다. */
  eventDefinitionsByKey?: Record<string, EventDefinitionSummary> | null;
}

type CardState =
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
export function ApprovalRequestCard({ target, eventDefinitionsByKey }: ApprovalRequestCardProps) {
  const t = useTranslations('chats');
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const [resolving, setResolving] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

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

  useEffect(() => { void fetchGate(); }, [fetchGate]);

  const transition = async (status: 'approved' | 'rejected', note?: string) => {
    setResolving(true);
    setTransitionError(null);
    try {
      const res = await fetchWithAuth(`/api/gates/${target.gate_id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note: note?.trim() || null }),
      });
      if (res.ok) { await fetchGate(); return; }
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setTransitionError(body?.error?.message ?? `HTTP ${res.status}`);
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
      if (res.ok) { await fetchGate(); setDiscussDialogOpen(false); return; }
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setDiscussError(body?.error?.message ?? `HTTP ${res.status}`);
    } catch {
      setDiscussError(t('hitlSendFailed'));
    } finally {
      setDiscussSubmitting(false);
    }
  };

  const Icon = resolveEntityIcon(toEntityType(target.work_item_type)) ?? FileText;

  return (
    <div className="min-w-0 max-w-full rounded-xl rounded-tl-sm border border-border bg-card px-3.5 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-foreground">
        <Icon className="h-3 w-3" aria-hidden />
        {t('approvalRequestLabel')}
      </div>

      {state.kind === 'loading' ? (
        <div className="h-8 animate-pulse rounded-lg bg-muted" />
      ) : state.kind === 'not-found' ? (
        <p className="text-xs text-muted-foreground">{t('approvalRequestNotFound')}</p>
      ) : state.kind === 'error' ? (
        <p className="text-xs text-muted-foreground">{t('approvalRequestLoadError')}</p>
      ) : (
        <ApprovalRequestBody
          gate={state.gate}
          resolving={resolving}
          transitionError={transitionError}
          onApprove={(reason) => void transition('approved', reason)}
          onReject={(reason) => void transition('rejected', reason)}
          onDiscuss={(reason) => void discuss(reason)}
          onDiscussClick={() => setDiscussDialogOpen(true)}
          onUndone={() => void fetchGate()}
          eventDefinitionsByKey={eventDefinitionsByKey}
        />
      )}
      {state.kind === 'ready' ? (
        <GateDiscussDialog
          open={discussDialogOpen}
          onOpenChange={setDiscussDialogOpen}
          onSubmit={(reason) => void discuss(reason)}
          submitting={discussSubmitting}
          error={discussError}
        />
      ) : null}
    </div>
  );
}

function ApprovalRequestBody({
  gate, resolving, transitionError, onApprove, onReject, onDiscuss, onDiscussClick, onUndone, eventDefinitionsByKey,
}: {
  gate: GateItem;
  resolving: boolean;
  transitionError: string | null;
  onApprove: (reason?: string) => void;
  onReject: (reason?: string) => void;
  /** story #2631 — 고위험(서명) 플로우가 이미 가진 사유 필드를 그대로 재사용해 직접 제출. */
  onDiscuss: (reason: string) => void;
  /** story #2631 — 저위험 플로우엔 사유 입력창이 없어 별도 다이얼로그를 연다. */
  onDiscussClick: () => void;
  onUndone: () => void;
  eventDefinitionsByKey?: Record<string, EventDefinitionSummary> | null;
}) {
  const t = useTranslations('chats');
  // gates/[id]/page.tsx와 같은 문구를 쓴다(동일 개념=동일 어휘, DS 원칙) — 그 키들은 'cage'
  // 네임스페이스에 있다('chats'엔 없음, 그라운딩 중 확認).
  const tCage = useTranslations('cage');
  const { currentTeamMemberId } = useDashboardContext();
  const title = gate.work_item_summary?.title ?? `#${gate.work_item_id.slice(0, 8)}`;

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
      work_item_title: title,
      resolution_note: gate.resolution_note ?? null,
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
    return renderBlockTemplate({ blocks: blocksToRender }, payload).filter((b) => b.type === 'text' || b.type === 'fields');
  })() : null;
  const riskLevel = deriveRiskLevel(gate);
  const needsFullFlow = usesSignatureFlow(riskLevel);
  const canAct = gate.status === 'pending' && gate.can_approve === true;
  const [showPreview, setShowPreview] = useState(false);
  // story #2118(E-DG-REAL) — doc 전용이던 제목 진입점을 전 work_item_type으로 확장한다.
  // EntityPreviewModal은 이미 fetch 전략이 없는(또는 rich preview가 없는) 타입도 크래시 없이
  // "이 엔티티는 별도 미리보기가 없습니다"로 정직하게 떨어진다(embed-card.tsx 실측 확認) —
  // 그래서 진입점 자체를 막을 필요가 없다. 억지로 빈 모달을 "숨기는" 게 아니라, 모달이 이미
  // 그 빈 상태를 정직하게 보여줄 수 있으므로 항상 연다.
  const previewEntityType = toEntityType(gate.work_item_type);

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setShowPreview(true)}
        className="group/preview flex w-full min-w-0 items-center gap-1 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground group-hover/preview:underline">{title}</span>
        <Eye className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {gate.status === 'pending' && (riskLevel === 'high' || riskLevel === 'unknown') ? (
        <Badge variant={riskLevel === 'high' ? 'warning' : 'outline'} className={riskLevel === 'unknown' ? 'text-muted-foreground' : undefined}>
          {riskLevel === 'high' ? tCage('riskHigh') : tCage('riskUnknown')}
        </Badge>
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
      ) : !canAct ? (
        // story #2091(P0)과 동일 fail-closed 규율 — can_approve=false(무권한 뷰어)는 액션을
        // 렌더하지 않는다. 고위험도 이제 챗 안에서 완결되므로(#2625) 여기 남는 유일한
        // "액션 불가" 사유는 무권한뿐이다.
        <p className="text-[11px] text-muted-foreground">{tCage('gateReadonlyNotAuthorized')}</p>
      ) : needsFullFlow ? (
        <GateSignatureApproval
          gate={gate}
          resolving={resolving}
          error={transitionError}
          onApprove={onApprove}
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

      {showPreview && (
        <EntityPreviewModal
          entityType={previewEntityType}
          entityId={gate.work_item_id}
          title={title}
          status={null}
          href={getEntityHref(previewEntityType, gate.work_item_id)}
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  );
}
