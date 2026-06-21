'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Shield, ShieldCheck, ShieldX, Sparkles, User, CheckCircle, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { gateNeedsAction } from '@/components/cage/gate-evidence';
import type { GateItem } from '@/components/kanban/types';
import type { Hypothesis } from '@sprintable/core-storage';

/**
 * E-DG S24 ⓑ — hypothesis gate approval 축(카드 상단 full-width 띠).
 * outcome 축(본문 hypothesis-status-badge/verdict-card)과 2축 분리(PO "혼동 금지").
 * 데이터 = hypGatesMap(`/api/gates?work_item_type=hypothesis&work_item_id=`·S23 work_item_type='hypothesis').
 * 3상태: gate.status==='rejected' / gate pending / hyp active+confirmed_by. 신규 토큰 0.
 */
type GateState = 'pending' | 'confirmed' | 'rejected';

const META: Record<GateState, { variant: 'warning' | 'success' | 'destructive'; Icon: typeof Shield; labelKey: string }> = {
  pending: { variant: 'warning', Icon: Shield, labelKey: 'gatePending' },
  confirmed: { variant: 'success', Icon: ShieldCheck, labelKey: 'gateConfirmed' },
  rejected: { variant: 'destructive', Icon: ShieldX, labelKey: 'gateRejected' },
};

// gate-approval 축은 outcome lifecycle(active→measuring→verified)와 독립 — confirmed_by가 박히면
// "확인됨"이 verified 단계까지 유지돼야 done-gate(gate녹+outcome녹 동시·3중 분리)가 성립한다.
function deriveGateState(hypothesis: Hypothesis, gate: GateItem | undefined): GateState | null {
  if (gate?.status === 'rejected') return 'rejected';
  if (gate?.status === 'pending') return 'pending';
  if (hypothesis.confirmed_by_member_id) return 'confirmed';
  return null;
}

interface HypothesisGateBadgeProps {
  hypothesis: Hypothesis;
  gate: GateItem | undefined;
  resolveName?: (memberId: string) => string;
  resolverId?: string;
  onResolved?: () => void;
  // S24 follow-up: story-칩 연결 surface용 compact 모드 — 작은 Shield indicator(pending/rejected만·title 툴팁·라벨/evidence/action 생략).
  compact?: boolean;
}

export function HypothesisGateBadge({ hypothesis, gate, resolveName = (id) => id, resolverId = '', onResolved = () => {}, compact = false }: HypothesisGateBadgeProps) {
  const t = useTranslations('hypotheses');
  const [resolving, setResolving] = useState(false);
  const [rejectNote, setRejectNote] = useState<string | null>(null); // null=닫힘·string=반려 입력 中

  const state = deriveGateState(hypothesis, gate);
  if (!state) return null; // gate-approval 흐름 아닐 때 미표시(노이즈 0·boy-scout)

  const meta = META[state];
  const MetaIcon = meta.Icon;

  // compact(story-칩 연결 surface): 작은 Shield indicator — pending/rejected만(주의 필요·confirmed 생략 boy-scout)·title 툴팁·라벨/evidence/action 생략.
  if (compact) {
    if (state === 'confirmed') return null;
    return (
      <span title={t(meta.labelKey)} aria-label={t(meta.labelKey)} className="inline-flex shrink-0 items-center">
        <MetaIcon className={`size-3.5 ${state === 'rejected' ? 'text-destructive' : 'text-warning'}`} />
      </span>
    );
  }

  const canAct = state === 'pending' && gate != null && gateNeedsAction(gate);

  const transition = async (status: 'approved' | 'rejected', note?: string) => {
    if (!gate || resolving) return;
    setResolving(true);
    try {
      const res = await fetch(`/api/gates/${gate.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, resolver_id: resolverId, note: note || null }),
      });
      if (res.ok) onResolved();
    } finally {
      setResolving(false);
      setRejectNote(null);
    }
  };

  // 결재자/초안자 evidence 미니(띠 우측). 확인=confirmed_by / 반려=gate.resolver_id(반려 경로엔 confirmed_by 미설정·QA LOW① fix·doc §3 "반려 시 {사람명}").
  const draftedBy = hypothesis.drafted_by_member_id;
  const actorId = state === 'rejected' ? (gate?.resolver_id ?? null) : hypothesis.confirmed_by_member_id;

  return (
    <div className="space-y-1.5 rounded-xl border border-border bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={meta.variant} className="shrink-0 gap-1">
          <MetaIcon className="size-3 shrink-0" />
          {t(meta.labelKey)}
        </Badge>
        {/* owner/drafted_by/confirmed_by 구분 미니 evidence */}
        {draftedBy ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Sparkles className="size-3 shrink-0" />
            {t('gateDraftedBy', { name: resolveName(draftedBy) })}
          </span>
        ) : null}
        {actorId && (state === 'confirmed' || state === 'rejected') ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <User className="size-3 shrink-0" />
            {t(state === 'rejected' ? 'gateRejectedBy' : 'gateConfirmedBy', { name: resolveName(actorId) })}
          </span>
        ) : null}
        {/* approve/reject = GateInbox action 재사용(requires_human·pending 시만) */}
        {canAct && rejectNote === null ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-success hover:bg-success-tint hover:text-success"
              disabled={resolving}
              onClick={() => void transition('approved')}
            >
              <CheckCircle className="size-3.5" />
              {t('gateApprove')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              disabled={resolving}
              onClick={() => setRejectNote('')}
            >
              <XCircle className="size-3.5" />
              {t('gateReject')}
            </Button>
          </div>
        ) : null}
      </div>
      {/* 반려 사유 입력(인라인) */}
      {canAct && rejectNote !== null ? (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            placeholder={t('gateRejectNotePlaceholder')}
            className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={resolving}
            onClick={() => void transition('rejected', rejectNote)}
          >
            {resolving ? '…' : t('gateRejectConfirm')}
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => setRejectNote(null)}>
            {t('gateCancel')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
