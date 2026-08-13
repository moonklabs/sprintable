'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, FileText, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { deriveRiskLevel, usesSignatureFlow } from '@/components/cage/gate-risk';
import type { GateItem } from '@/components/kanban/types';

export interface ApprovalTarget {
  work_item_type: string;
  work_item_id: string;
  gate_id: string;
  actions: string[];
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

/**
 * story #2604 P2 — chat approval-request 카드. BE(#3007)가 payload에 실은 `approval_target`
 * (work_item_type/work_item_id/gate_id/actions)을 렌더한다. 새 API는 만들지 않는다(AC③) —
 * 상태 조회는 기존 `GET /api/gates/{id}`, 액션은 기존 `POST /api/gates/{id}/transition`
 * 그대로(gates/[id]/page.tsx와 동일 계약·동일 envelope 언랩) — human-only SoD 인가는 그
 * 엔드포인트가 이미 지킨다(신규 인가 없음).
 *
 * 고위험(usesSignatureFlow)·무권한(can_approve=false)은 이 컴팩트 카드 안에서 서명플로우를
 * 재구현하지 않는다 — 결재함 상세(`/gates/{id}`)로 열기 링크만 준다(no-fiction: 챗 카드
 * 폭에 서명 플로우를 욱여넣는 대신 정직하게 위임).
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

  const transition = async (status: 'approved' | 'rejected') => {
    setResolving(true);
    setTransitionError(null);
    try {
      const res = await fetch(`/api/gates/${target.gate_id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note: null }),
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
          gateId={target.gate_id}
          resolving={resolving}
          transitionError={transitionError}
          onApprove={() => void transition('approved')}
          onReject={() => void transition('rejected')}
        />
      )}
    </div>
  );
}

function ApprovalRequestBody({
  gate, gateId, resolving, transitionError, onApprove, onReject,
}: {
  gate: GateItem;
  gateId: string;
  resolving: boolean;
  transitionError: string | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  const t = useTranslations('chats');
  // gates/[id]/page.tsx와 같은 문구를 쓴다(동일 개념=동일 어휘, DS 원칙) — 그 키들은 'cage'
  // 네임스페이스에 있다('chats'엔 없음, 그라운딩 중 확認).
  const tCage = useTranslations('cage');
  const title = gate.work_item_summary?.title ?? `#${gate.work_item_id.slice(0, 8)}`;
  const riskLevel = deriveRiskLevel(gate);
  const needsFullFlow = usesSignatureFlow(riskLevel);
  const canActInline = gate.status === 'pending' && gate.can_approve === true && !needsFullFlow;

  return (
    <div className="space-y-2">
      <p className="truncate text-sm font-medium text-foreground">{title}</p>

      {gate.status !== 'pending' ? (
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          {gate.status === 'approved' ? <Check className="h-3.5 w-3.5 text-primary" /> : <X className="h-3.5 w-3.5 text-destructive" />}
          {t('approvalRequestResolvedStatus', { status: gate.status })}
        </div>
      ) : canActInline ? (
        <>
          {transitionError ? (
            <p role="alert" aria-live="assertive" className="text-[11px] text-foreground">
              {tCage('gateTransitionError', { reason: transitionError })}
            </p>
          ) : null}
          <div className="flex gap-1.5">
            <Button type="button" size="sm" onClick={onApprove} disabled={resolving} className="flex-1">
              <Check className="h-3.5 w-3.5" aria-hidden />
              {tCage('gateApprove')}
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={onReject} disabled={resolving} className="flex-1">
              <X className="h-3.5 w-3.5" aria-hidden />
              {tCage('gateReject')}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            {gate.can_approve === false ? tCage('gateReadonlyNotAuthorized') : t('approvalRequestOpenForFullReview')}
          </p>
          {gate.can_approve !== false ? (
            <a
              href={`/gates/${gateId}`}
              className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              {t('approvalRequestOpenInGates')}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ) : null}
        </div>
      )}

      {gate.status === 'pending' && (riskLevel === 'high' || riskLevel === 'unknown') ? (
        <Badge variant={riskLevel === 'high' ? 'warning' : 'outline'} className={riskLevel === 'unknown' ? 'text-muted-foreground' : undefined}>
          {riskLevel === 'high' ? tCage('riskHigh') : tCage('riskUnknown')}
        </Badge>
      ) : null}
    </div>
  );
}
