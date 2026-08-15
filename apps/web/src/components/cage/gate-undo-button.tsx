'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { GateItem } from '@/components/kanban/types';

// story #2631(FE 계약 doc bb733f26) — BE GATE_UNDO_WINDOW와 같은 값(5분). 최종 인가는 BE가
// 재검증(해소자 본인+창)하므로 이 상수가 서버와 어긋나도 보안 구멍은 아니다 — 다만 "눌러도
// 안 되는 버튼을 계속 보여주는" UX 결함(spec이 명시적으로 경고)을 막기 위해 클라도 같은
// 창으로 버튼 노출 여부를 미리 판단한다.
export const UNDO_WINDOW_MS = 5 * 60 * 1000;

export function isUndoEligible(
  gate: Pick<GateItem, 'status' | 'resolver_id' | 'resolved_at'>,
  currentTeamMemberId: string | undefined,
): boolean {
  if (!currentTeamMemberId) return false;
  if (gate.status !== 'approved' && gate.status !== 'rejected') return false;
  if (gate.resolver_id !== currentTeamMemberId) return false;
  if (!gate.resolved_at) return false;
  return Date.now() - new Date(gate.resolved_at).getTime() < UNDO_WINDOW_MS;
}

/** 해소 직후 취소(오클릭 정정). isUndoEligible()로 이미 걸러진 자리에서만 렌더할 것 —
 * 이 컴포넌트 자체는 재검사하지 않는다(호출부가 판단, BE가 최종 인가). */
export function GateUndoButton({
  gateId,
  onUndone,
  compact = false,
}: {
  gateId: string;
  onUndone: (gate: GateItem) => void;
  compact?: boolean;
}) {
  const t = useTranslations('cage');
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUndo = async () => {
    setUndoing(true);
    setError(null);
    try {
      const res = await fetch(`/api/gates/${gateId}/undo`, { method: 'POST' });
      if (res.ok) {
        const json = await res.json().catch(() => null) as { data?: GateItem } | GateItem | null;
        const gate = (json && 'data' in json ? json.data : json) as GateItem | undefined;
        if (gate) { onUndone(gate); return; }
      }
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? t('gateTransitionErrorGeneric'));
    } catch {
      setError(t('gateTransitionErrorGeneric'));
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div className={compact ? 'flex flex-col items-start gap-1' : 'flex flex-col items-end gap-1'}>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 gap-1 text-muted-foreground"
        disabled={undoing}
        onClick={() => void handleUndo()}
      >
        <RotateCcw className="size-3.5" />
        {undoing ? '...' : t('gateUndo')}
      </Button>
      {error ? (
        <p role="alert" aria-live="assertive" className="text-[11px] text-foreground">
          {t('gateTransitionError', { reason: error })}
        </p>
      ) : null}
    </div>
  );
}
