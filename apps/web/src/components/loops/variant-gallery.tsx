'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { OperatorTextarea } from '@/components/ui/operator-control';
import { ArtifactPreview } from '@/components/loops/artifact-preview';
import { OutcomeBadge } from '@/components/loops/outcome-badge';
import { Layers } from 'lucide-react';

/** loop_outcome_attribution.py 산출 shape — closed loop에만 존재. */
export interface OutcomeInfo {
  hypothesis_status: 'verified' | 'falsified';
}

export interface LoopArtifact {
  id: string;
  loop_id: string;
  asset_id: string;
  variant_group: string;
  variant_label: string;
  decision: 'pending' | 'chosen' | 'rejected';
  choose_reason: string | null;
  rejection_reason: string | null;
  sort_order: number;
  /**
   * E-LOOP-LEDGER S24 — 카드 렌더 분기 키(image/* vs text/* vs 기타). optional인 이유: 디디 BE가
   * 이 필드를 아직 안 실어주는 크로스-PR 과도기가 있을 수 있음(ArtifactPreview가 null-safe 폴백).
   */
  content_type?: string;
  /** text/*일 때만·capped(~4KB). image/*는 null(기존 sign 경로 그대로). */
  text_content?: string | null;
  /** true면 원본이 4KB cap을 초과 — text_content는 발췌. */
  text_truncated?: boolean;
}

export interface VariantGroup {
  variant_group: string;
  artifacts: LoopArtifact[];
}

/**
 * ⭐ 결정 UX = 이 화면의 심장(handoff §2). 슬롯(variant_group) 1개 = 1 결정 제출(선택 1 + 반려
 * N 이유 한 번에, 원자적). choose_reason/rejection_reason 둘 다 min1 — 복리 학습 moat 신호원이라
 * 강제가 아닌 자연스러운 유도로(라디오+인라인 이유칸, 별도 모달/경고 없음).
 */
function VariantSlot({
  loopId,
  group,
  canDecide,
  onDecided,
  outcome,
}: {
  loopId: string;
  group: VariantGroup;
  canDecide: boolean;
  onDecided: () => void;
  outcome: OutcomeInfo | null;
}) {
  const t = useTranslations('loops');
  const sorted = [...group.artifacts].sort((a, b) => a.sort_order - b.sort_order);
  const pending = sorted.filter((a) => a.decision === 'pending');
  const decided = pending.length === 0;

  const [chosenId, setChosenId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const otherPending = pending.filter((a) => a.id !== chosenId);
  const canSubmit =
    !!chosenId &&
    (reasons[chosenId]?.trim().length ?? 0) > 0 &&
    otherPending.every((a) => (reasons[a.id]?.trim().length ?? 0) > 0) &&
    !submitting;

  async function handleSubmit() {
    if (!canSubmit || !chosenId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/loops/${loopId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisions: [
            {
              variant_group: group.variant_group,
              chosen_artifact_id: chosenId,
              choose_reason: reasons[chosenId]?.trim(),
              rejections: otherPending.map((a) => ({
                artifact_id: a.id,
                rejection_reason: reasons[a.id]?.trim(),
              })),
            },
          ],
        }),
      });
      if (res.ok) {
        setChosenId(null);
        setReasons({});
        onDecided();
      } else {
        const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(json?.error?.message ?? t('decisionError'));
      }
    } catch {
      setError(t('decisionError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2.5">
        <span className="text-sm font-semibold text-foreground">{group.variant_group}</span>
        {decided ? (
          <Badge variant="success">{t('slotDecided')}</Badge>
        ) : canDecide ? (
          <span className="text-xs font-medium text-primary">{t('slotDeciding')}</span>
        ) : (
          <Badge variant="outline">{t('slotCandidates', { count: sorted.length })}</Badge>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((artifact) => {
          const isChosen = artifact.decision === 'chosen';
          const isRejected = artifact.decision === 'rejected';
          const isPendingSelectable = artifact.decision === 'pending' && canDecide && !decided;
          const selectedForSubmit = chosenId === artifact.id;

          return (
            <div
              key={artifact.id}
              className={`overflow-hidden rounded-lg border transition ${
                isChosen
                  ? 'border-success ring-1 ring-success/40'
                  : isRejected
                    ? 'border-border opacity-55'
                    : selectedForSubmit
                      ? 'border-primary ring-1 ring-primary/40'
                      : 'border-border'
              }`}
            >
              <div className="relative h-28 bg-muted">
                <ArtifactPreview
                  assetId={artifact.asset_id}
                  fallbackLabel={artifact.variant_label}
                  contentType={artifact.content_type}
                  textContent={artifact.text_content ?? null}
                  textTruncated={artifact.text_truncated ?? false}
                />
              </div>
              <div className="space-y-1.5 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-foreground">{artifact.variant_label}</span>
                  <div className="flex shrink-0 items-center gap-1">
                    {isChosen ? <Badge variant="success" className="text-[9px]">{t('chosenBadge')}</Badge> : null}
                    {isChosen && outcome ? (
                      <OutcomeBadge hypothesisStatus={outcome.hypothesis_status} className="text-[9px]" />
                    ) : null}
                  </div>
                </div>

                {isChosen && artifact.choose_reason ? (
                  <p className="rounded-md border border-border bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
                    {artifact.choose_reason}
                  </p>
                ) : null}
                {isRejected && artifact.rejection_reason ? (
                  <p className="rounded-md border border-border bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
                    {artifact.rejection_reason}
                  </p>
                ) : null}

                {isPendingSelectable ? (
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                      <input
                        type="radio"
                        name={`slot-${group.variant_group}`}
                        checked={selectedForSubmit}
                        onChange={() => setChosenId(artifact.id)}
                      />
                      {t('chosenBadge')}
                    </label>
                    <OperatorTextarea
                      value={reasons[artifact.id] ?? ''}
                      onChange={(e) => setReasons((prev) => ({ ...prev, [artifact.id]: e.target.value }))}
                      placeholder={selectedForSubmit ? t('chooseReasonPlaceholder') : t('rejectionReasonPlaceholder')}
                      className="min-h-[52px] text-xs"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      {selectedForSubmit ? t('chooseReasonLabel') : t('rejectionReasonLabel')}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {!decided && canDecide ? (
        <div className="space-y-2 border-t border-border px-4 py-3">
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground">{t('confirmSlotHint')}</p>
            <Button size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
              {submitting ? t('confirmSlotSubmitting') : t('confirmSlot')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function VariantGallery({
  loopId,
  groups,
  canDecide,
  onDecided,
  outcome = null,
}: {
  loopId: string;
  groups: VariantGroup[];
  canDecide: boolean;
  onDecided: () => void;
  outcome?: OutcomeInfo | null;
}) {
  const t = useTranslations('loops');

  if (groups.length === 0) {
    return <EmptyState icon={<Layers />} title={t('noArtifacts')} />;
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <VariantSlot
          key={group.variant_group}
          loopId={loopId}
          group={group}
          canDecide={canDecide}
          onDecided={onDecided}
          outcome={outcome}
        />
      ))}
    </div>
  );
}
