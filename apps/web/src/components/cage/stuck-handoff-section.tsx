'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { GateLineContext } from '@/components/cage/gate-line-context';
import { StuckHandoffDetail } from '@/components/cage/stuck-handoff-detail';
import type { KanbanMember, WorkflowLineStatus, WorkflowLineStepRun } from '@/components/kanban/types';
import { fetchWithAuth } from '@/lib/db/client';
import { memberLookup } from '@/lib/member-display';
import { useMemberNameFallback } from '@/hooks/use-member-name-fallback';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

/**
 * E-DG S12 ① — detail drawer "워크플로우 라인 상태" 섹션(story-detail-panel DISPATCH 직후 마운트).
 * handoff_stuck(delivery_status==='timed_out')일 때만 조건부 렌더(평상시 숨김·노이즈 0·boy-scout).
 * 경고 헤더 → S11 GateLineContext 재사용 → StuckHandoffDetail → fallback action(상태머신).
 * 데이터 = S11 per-story workflow-line/status(추가 BE 0). 신규 토큰 0.
 */
type FallbackState = 'idle' | 'notifying' | 'notified' | 'failed';
// story #2272 — 형제(fallback-notify)와 같은 흐름 안의 withdraw. 되돌릴 수 없는 조작이라
// 'confirming' 단계를 둔다(⛔단클릭 바로 실행 금지) — AC5.
type WithdrawState = 'idle' | 'confirming' | 'withdrawing' | 'withdrawn' | 'failed';

interface StuckHandoffSectionProps {
  storyId: string;
  memberMap?: Record<string, KanbanMember>;
}

export function StuckHandoffSection({ storyId, memberMap = {} }: StuckHandoffSectionProps) {
  const t = useTranslations('cage');
  // story #4284 — 이름 없는 구성원 표시(common.memberUnnamed).
  const tc = useTranslations('common');
  const [step, setStep] = useState<WorkflowLineStepRun | null>(null);
  const [fallback, setFallback] = useState<FallbackState>('idle');
  const [withdraw, setWithdraw] = useState<WithdrawState>('idle');
  const { addToast } = useToast();

  // [SID:4300] 승인자 이름 = 넘겨받은 표(스토리 패널 · 프로젝트 범위 + 조직 보충) + 이 칸의 승인자가 거기 없을 때만 조직 범위.
  // 이 칸은 자기 데이터(workflow-line/status)를 따로 받아, 패널이 모르는 id가 여기서만 보일 수 있다. 조직 목록은 org별 한 번(캐시).
  const { orgId } = useDashboardContext();
  const approverNames = useMemberNameFallback(orgId, memberMap, (step?.approvers ?? []).map((a) => a.member_id), true);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth(`/api/stories/${storyId}/workflow-line/status`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<WorkflowLineStatus>) : null))
      .then((ls) => { if (!cancelled) setStep(ls?.active ?? null); })
      .catch(() => { if (!cancelled) setStep(null); });
    return () => { cancelled = true; };
  }, [storyId]);

  // 조건부: handoff_stuck 일 때만(노이즈 0).
  if (!step || step.delivery_status !== 'timed_out') return null;

  const handleFallback = async () => {
    if (fallback === 'notifying' || fallback === 'notified') return; // idempotent·재클릭 방지
    setFallback('notifying');
    try {
      // ⚠️ 갭2: fallback BE 액션 provisional 경로(디디/산티아고 계약 확정 후 정합). idempotent·200/"이미 통지됨"·status 안 되돌림.
      const res = await fetch(`/api/stories/${storyId}/workflow-line/fallback-notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        setFallback('notified');
        addToast({ type: 'success', title: t('fallbackNotifySuccess') });
      } else {
        setFallback('failed');
        addToast({ type: 'error', title: t('fallbackNotifyError') });
      }
    } catch {
      setFallback('failed');
      addToast({ type: 'error', title: t('fallbackNotifyError') });
    }
  };

  // story #2272 AC5 — withdraw는 되돌릴 수 없다(BE: run.status='withdrawn'은 terminal, 재개
  // 엔드포인트 없음, gate/approval도 함께 닫힘). 그래서 idle→confirming(경고 노출)→withdrawing
  // 순서를 강제한다 — ⛔"되돌릴 수 없습니다"를 숨기지 않는다.
  const handleWithdraw = async () => {
    if (withdraw === 'withdrawing' || withdraw === 'withdrawn') return;
    if (withdraw !== 'confirming') { setWithdraw('confirming'); return; }
    setWithdraw('withdrawing');
    try {
      const res = await fetch(`/api/stories/${storyId}/workflow-line/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step_run_id: step.id }),
      });
      if (res.ok) {
        setWithdraw('withdrawn');
        addToast({ type: 'success', title: t('withdrawSuccess') });
      } else {
        setWithdraw('failed');
        addToast({ type: 'error', title: t('withdrawError') });
      }
    } catch {
      setWithdraw('failed');
      addToast({ type: 'error', title: t('withdrawError') });
    }
  };

  const btn = {
    // story 3466 후속(무효 유틸 4곳) — text-destructive-foreground는 이 테마에 매핑이
    // 없는 no-op(라이트 3.55·다크 3.00, AA 미달). trust-seal.tsx 선례와 같은 처방.
    idle: { cls: 'bg-destructive text-white dark:text-proof-bg hover:bg-destructive/90', Icon: AlertTriangle, label: t('fallbackNotifyOwner'), disabled: false },
    notifying: { cls: 'bg-destructive-tint text-destructive', Icon: Loader2, label: t('fallbackNotifying'), disabled: true },
    notified: { cls: 'bg-muted text-muted-foreground', Icon: Check, label: t('fallbackNotified'), disabled: true },
    failed: { cls: 'border border-destructive text-destructive hover:ring-1 hover:ring-inset hover:ring-destructive/60', Icon: RotateCcw, label: t('fallbackRetry'), disabled: false },
  }[fallback];
  const BtnIcon = btn.Icon;

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <p className="mb-2 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">{t('workflowLineContext')}</p>
      <div className="space-y-2.5">
        {/* ⓐ 경고 헤더 */}
        <Badge variant="destructive" className="gap-1">
          <AlertTriangle className="size-3 shrink-0" />
          <span>{t('lineHandoffStuck')}</span>
        </Badge>
        {/* ⓑ S11 GateLineContext 재사용(무변경) */}
        {/* [SID:4286] 승인자 id 조각(앞 6자)을 이름 칸에 싣지 않는다 — 표에 없음 → «알 수 없는 구성원». 이 섹션은 스토리 상세 패널 안이라
            (스토리를 눌러야 열림) 보드가 구성원 표를 이미 받은 뒤다 → loaded: true. 흐름 화면 패널은 표를 안 넘겨 늘 «알 수 없음»(PR 본문 (나) 후속). */}
        <GateLineContext step={step} resolveName={(id) => memberLookup(approverNames.memberMap, id, tc, { loaded: approverNames.loaded })?.label ?? ''} />
        {/* ⓒ StuckHandoffDetail */}
        <StuckHandoffDetail step={step} />
        {/* ⓓ fallback action(상태머신) */}
        <Button
          variant="ghost"
          className={`w-full gap-1.5 ${btn.cls}`}
          disabled={btn.disabled}
          onClick={() => void handleFallback()}
        >
          <BtnIcon className={`size-3.5 shrink-0 ${fallback === 'notifying' ? 'animate-spin' : ''}`} />
          {btn.label}
        </Button>
        {/* story #2272 — ⓔ withdraw(형제 fallback-notify와 같은 흐름). 되돌릴 수 없어 confirm 단계 */}
        {withdraw === 'withdrawn' ? (
          <div className="flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5 shrink-0" />
            {t('withdrawn')}
          </div>
        ) : withdraw === 'confirming' ? (
          <div className="space-y-1.5 rounded-md border border-destructive/40 bg-destructive-tint p-2">
            <p className="text-[11px] text-foreground">{t('withdrawIrreversibleWarning')}</p>
            <div className="flex gap-1.5">
              {/* story #3869(AC1) — 이 버튼은 withdraw==='confirming'에서만 렌더되고, 그
                  조상 div가 상시 bg-destructive-tint(리터럴, 132행)라 text-muted-foreground는
                  AA 미달(#3839류) — text-foreground로 교체(§③ ink 규칙, 새 토큰 0). */}
              <Button variant="ghost" size="sm" className="flex-1 text-foreground" onClick={() => setWithdraw('idle')}>
                {t('withdrawCancel')}
              </Button>
              <Button variant="ghost" size="sm" className="flex-1 gap-1 text-destructive hover:ring-1 hover:ring-inset hover:ring-destructive/60" onClick={() => void handleWithdraw()}>
                <XCircle className="size-3.5 shrink-0" />
                {t('withdrawConfirm')}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="w-full gap-1.5 text-muted-foreground hover:text-destructive"
            disabled={withdraw === 'withdrawing'}
            onClick={() => void handleWithdraw()}
          >
            {withdraw === 'withdrawing' ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <XCircle className="size-3.5 shrink-0" />}
            {withdraw === 'withdrawing' ? t('withdrawing') : t('withdrawRequest')}
          </Button>
        )}
      </div>
    </div>
  );
}
