'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import { LAYER } from '@/components/ds/layers';
import { Radio, RadioGroup } from '@/components/ds/radio';
import { SectionHeader } from '@/components/ds/section-header';
import { Textarea } from '@/components/ds/input';
import { ArtifactPreview } from '@/components/loops/artifact-preview';
import { OutcomeBadge } from '@/components/loops/outcome-badge';
import { cn } from '@/lib/utils';

/**
 * 4911 — 후보 갤러리의 층: 슬롯 카드 = 내용 칸(panel) · 후보 타일 면 = 남의 글 줄(rowOthers) · 썸네일 칸 = 우물(well) · 타일 안 이유 칸(입력 · 읽기) = 내용 칸(panel).
 * 이유 칸이 sunk가 아니라 panel인 까닭: 글 줄 면 위에 입력칸 면(sunk)을 얹으면 라이트에서 면이 안 갈린다(4908 속성 칸과 같은 이유) — 경계(line-control)가 함께 가른다.
 * 화면 코드는 층 표 이름을 그대로 쓰고 `styles/layer-rule.test.ts`가 이 이름과 그 사이 밝기차를 지킨다.
 */
export const VARIANT_TILE_FACE = LAYER.rowOthers;
export const VARIANT_TILE_WELL = LAYER.well;
export const VARIANT_REASON_FACE = LAYER.panel;

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
        // story #2485 — code로 분기(backend loops.py decide_loop()가 dict{code,message}로
        // 직접 발급 — route.ts 주석대로 순수 passthrough, mapApiError 경유 아님). 알려지지
        // 않은 code만 안전 폴백(raw message 미노출).
        const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        switch (json?.error?.code) {
          case 'LOOP_NOT_FOUND':
            setError(t('decisionErrorLoopNotFound'));
            break;
          case 'DECISION_HUMAN_ONLY':
            setError(t('decisionErrorHumanOnly'));
            break;
          case 'LOOP_NOT_IN_DECIDING_STATE':
            setError(t('decisionErrorNotDeciding'));
            break;
          case 'GATE_ALREADY_RESOLVED':
            setError(t('decisionErrorGateResolved'));
            break;
          case 'NO_PENDING_ARTIFACTS_IN_GROUP':
            setError(t('decisionErrorNoPendingArtifacts'));
            break;
          case 'ARTIFACT_SET_MISMATCH':
            setError(t('decisionErrorArtifactSetMismatch'));
            break;
          default:
            setError(t('decisionError'));
        }
      }
    } catch {
      setError(t('decisionError'));
    } finally {
      setSubmitting(false);
    }
  }

  const header = (
    <SectionHeader
      title={group.variant_group}
      level={3}
      trailing={
        decided ? (
          <Chip tone="done" dot>{t('slotDecided')}</Chip>
        ) : canDecide ? (
          <Chip tone="needs-hand" dot>{t('slotDeciding')}</Chip>
        ) : (
          <Chip>{t('slotCandidates', { count: sorted.length })}</Chip>
        )
      }
    />
  );

  const tiles = sorted.map((artifact) => {
    const isChosen = artifact.decision === 'chosen';
    const isRejected = artifact.decision === 'rejected';
    const isPendingSelectable = artifact.decision === 'pending' && canDecide && !decided;
    const selectedForSubmit = chosenId === artifact.id;

    return (
      <div
        key={artifact.id}
        data-slot="variant-tile"
        data-decision={artifact.decision}
        className={cn(
          'overflow-hidden rounded-ds-control border',
          VARIANT_TILE_FACE,
          // 결정 상태는 색만이 아니다: 선택 = done 테두리 + «선택» 칩 · 반려 = 점선 + «반려» 칩 · 고르는 중 = action 테두리 + 채워진 라디오.
          isChosen ? 'border-ds-done ring-1 ring-ds-done' : isRejected ? 'border-dashed border-ds-line-control' : selectedForSubmit ? 'border-ds-action ring-1 ring-ds-action' : 'border-ds-line',
        )}
      >
        <div className={cn('relative h-28', VARIANT_TILE_WELL)}>
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
            <span className="min-w-0 truncate text-ds-small font-semibold text-ds-ink">{artifact.variant_label}</span>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
              {isChosen ? <Chip tone="done" icon="check">{t('chosenBadge')}</Chip> : null}
              {isChosen && outcome ? <OutcomeBadge hypothesisStatus={outcome.hypothesis_status} /> : null}
              {isRejected ? <Chip>{t('contextPackRejectedLabel')}</Chip> : null}
            </div>
          </div>

          {isChosen && artifact.choose_reason ? (
            <p className={cn('m-0 rounded-ds-control border border-ds-line px-2 py-1 text-ds-small text-ds-ink-2', VARIANT_REASON_FACE)}>
              {artifact.choose_reason}
            </p>
          ) : null}
          {isRejected && artifact.rejection_reason ? (
            <p className={cn('m-0 rounded-ds-control border border-ds-line px-2 py-1 text-ds-small text-ds-ink-2', VARIANT_REASON_FACE)}>
              {artifact.rejection_reason}
            </p>
          ) : null}

          {isPendingSelectable ? (
            <div className="space-y-1.5">
              <Radio value={artifact.id} label={t('chosenBadge')} />
              {/* 입력칸 면 = 내용 칸(panel): 글 줄 면(rowOthers) 위에 sunk를 얹으면 라이트에서 면이 안 갈린다(4908 속성 칸과 같은 이유) — 경계(line-control)가 함께 가른다. */}
              <Textarea
                value={reasons[artifact.id] ?? ''}
                onChange={(e) => setReasons((prev) => ({ ...prev, [artifact.id]: e.target.value }))}
                aria-label={selectedForSubmit ? t('chooseReasonLabel') : t('rejectionReasonLabel')}
                placeholder={selectedForSubmit ? t('chooseReasonPlaceholder') : t('rejectionReasonPlaceholder')}
                className={cn('min-h-[52px]', VARIANT_REASON_FACE)}
              />
              <p className="m-0 text-ds-small text-ds-ink-3">
                {selectedForSubmit ? t('chooseReasonLabel') : t('rejectionReasonLabel')}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    );
  });

  const grid = 'grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3';
  const canPick = canDecide && !decided;

  return (
    <Card className="overflow-hidden" data-slot="variant-slot" data-testid={`variant-slot-${group.variant_group}`}>
      {header}
      {canPick ? (
        // 라디오 묶음 = 슬롯 하나(한 번에 하나 고르기 · 방향키). 이름 = 슬롯 이름.
        <RadioGroup aria-label={group.variant_group} value={chosenId ?? ''} onValueChange={(v) => setChosenId(String(v))} className={grid}>
          {tiles}
        </RadioGroup>
      ) : (
        <div className={grid}>{tiles}</div>
      )}

      {!decided && canDecide ? (
        <div className="space-y-2 border-t border-ds-line px-4 py-3">
          {error ? <p className="m-0 text-ds-small text-ds-failed" role="alert" aria-live="assertive" aria-atomic="true">{error}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="m-0 text-ds-small text-ds-ink-3">{t('confirmSlotHint')}</p>
            <Button variant="primary" disabled={!canSubmit} loading={submitting} onClick={() => void handleSubmit()}>
              {submitting ? t('confirmSlotSubmitting') : t('confirmSlot')}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
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
    // 후보가 없으면 큰 빈 칸 대신 한 줄(4911) — 있을 때만 슬롯 카드가 선다.
    return <p data-slot="variant-empty" className="m-0 text-ds-small text-ds-ink-3">{t('noArtifacts')}</p>;
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
