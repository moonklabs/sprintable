'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { GateEvidence } from '@/components/cage/gate-evidence';
import type { GateItem } from '@/components/kanban/types';

const MERGE_GATE_TYPE = 'merge';

/**
 * H1-S8 surface②: story-detail-panel 머지 게이트 evidence 섹션(read-only). 그 스토리에 merge
 * 게이트가 있으면 `GateEvidence` 1개 노출(decision 배지 + CI/신뢰도 facts + 사유). 없으면 렌더 0
 * (빈 섹션 미표시). 액션(승인/반려)은 surface①(GateInbox)에만 — 여기는 표시만.
 *
 * 데이터: GET /api/gates?work_item_id=<story>&work_item_type=story (raw 배열 패스스루). story↔gate
 * 매핑 단순(BE list_gates work_item_id 필터)이라 v1 포함(유나 기준·추가 BE 0).
 */
export function StoryMergeGate({ storyId }: { storyId: string }) {
  const t = useTranslations('cage');
  const [gate, setGate] = useState<GateItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/gates?work_item_id=${storyId}&work_item_type=story`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((gates: GateItem[]) => {
        if (cancelled) return;
        const merge = Array.isArray(gates)
          ? gates.find((g) => g.gate_type === MERGE_GATE_TYPE) ?? null
          : null;
        setGate(merge);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [storyId]);

  if (!gate) return null;

  return (
    <section aria-label={t('mergeGateTitle')} className="rounded-xl border border-border bg-muted/20 p-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">{t('mergeGateTitle')}</h3>
      <GateEvidence gate={gate} />
    </section>
  );
}
