'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, FileText, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GateSignatureApproval } from '@/components/cage/gate-signature-approval';
import { deriveRiskLevel, usesSignatureFlow } from '@/components/cage/gate-risk';
import type { GateItem } from '@/components/kanban/types';

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
}

type CardState =
  | { kind: 'loading' }
  /** 게이트가 없다(삭제 등) — AC4류 폴백: 조용한 실패 대신 정직한 문구. */
  | { kind: 'not-found' }
  | { kind: 'error' }
  | { kind: 'ready'; gate: GateItem };

const WORK_ITEM_ICON: Record<string, typeof FileText> = { doc: FileText };

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
 */
export function ApprovalRequestCard({ target }: ApprovalRequestCardProps) {
  const t = useTranslations('chats');
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const [resolving, setResolving] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const fetchGate = useCallback(async () => {
    try {
      const res = await fetch(`/api/gates/${target.gate_id}`);
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
      const res = await fetch(`/api/gates/${target.gate_id}/transition`, {
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

  const Icon = WORK_ITEM_ICON[target.work_item_type] ?? FileText;

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
        />
      )}
    </div>
  );
}

function ApprovalRequestBody({
  gate, resolving, transitionError, onApprove, onReject,
}: {
  gate: GateItem;
  resolving: boolean;
  transitionError: string | null;
  onApprove: (reason?: string) => void;
  onReject: (reason?: string) => void;
}) {
  const t = useTranslations('chats');
  // gates/[id]/page.tsx와 같은 문구를 쓴다(동일 개념=동일 어휘, DS 원칙) — 그 키들은 'cage'
  // 네임스페이스에 있다('chats'엔 없음, 그라운딩 중 확認).
  const tCage = useTranslations('cage');
  const title = gate.work_item_summary?.title ?? `#${gate.work_item_id.slice(0, 8)}`;
  const riskLevel = deriveRiskLevel(gate);
  const needsFullFlow = usesSignatureFlow(riskLevel);
  const canAct = gate.status === 'pending' && gate.can_approve === true;

  return (
    <div className="space-y-2">
      <p className="truncate text-sm font-medium text-foreground">{title}</p>

      {gate.status === 'pending' && (riskLevel === 'high' || riskLevel === 'unknown') ? (
        <Badge variant={riskLevel === 'high' ? 'warning' : 'outline'} className={riskLevel === 'unknown' ? 'text-muted-foreground' : undefined}>
          {riskLevel === 'high' ? tCage('riskHigh') : tCage('riskUnknown')}
        </Badge>
      ) : null}

      {gate.status !== 'pending' ? (
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
              같은 값을 보여준다. */}
          {gate.resolution_note ? (
            <p className="text-[11px] text-muted-foreground">{t('approvalRequestResolutionNote', { note: gate.resolution_note })}</p>
          ) : null}
        </div>
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
        </>
      )}
    </div>
  );
}
