'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GateEvidence } from '@/components/cage/gate-evidence';
import type { GateItem } from '@/components/kanban/types';

/**
 * story #1954(P1a-S4) — 고위험 게이트 서명 플로우. AC: "근거 열람+사유 없인 [승인하고 서명] 비활성".
 * 근거 열람 = 명시적 확인 상호작용(체크박스, 스크롤/펼침만으로는 열람 인정 안 함 — 우발적 통과 방지).
 * 사유 = 자유 텍스트 필수(빈 문자열 trim 후 거부). 풀스크린 페이지 내 섹션(시트/팝오버 아님, AC 준수).
 */
export function GateSignatureApproval({
  gate,
  resolving,
  error,
  onApprove,
  onReject,
  compact = false,
}: {
  gate: GateItem;
  resolving: boolean;
  // story #2043 AC3: 서버 거부 사유(예: 고위험 승인 note 필수 422)를 사람이 읽을 문구로.
  // "버튼 비활성"만으로는 왜 막혔는지가 안 보여 AC 미충족 — 이 화면은 근거 열람+사유 입력
  // 이후에나 버튼이 풀리므로, 서버 거부는 클라이언트 검증을 통과했는데도 막힌 경우라 더더욱
  // 이유를 보여줘야 한다.
  error?: string | null;
  onApprove: (reason: string) => void;
  onReject: (reason: string) => void;
  /** story #2625(유나 design 확定, 카디르 QA 320px 실측 대응) — 챗 카드 좁은 폭(실효 ~166px)
   * 컨텍스트. 원 컨텍스트(gates 페이지 672px)는 가로 2버튼이 여유롭지만, 좁은 폭에서
   * whitespace-nowrap+shrink-0(button.tsx 기본) 그대로면 라벨이 잘린다. truncate나
   * 아이콘-only는 금지(중대 액션 라벨 온전 필수, PO 확定) — 대신 세로 스택으로 각 버튼이
   * full-width를 갖게 한다. 컴포넌트를 포크하지 않고 이 prop 하나로 컨텍스트만 분기한다. */
  compact?: boolean;
}) {
  const t = useTranslations('cage');
  const [evidenceViewed, setEvidenceViewed] = useState(false);
  const [reason, setReason] = useState('');
  const canSign = evidenceViewed && reason.trim().length > 0 && !resolving;

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-[11px] font-semibold text-muted-foreground">{t('sigEvidenceLabel')}</p>
        <GateEvidence gate={gate} />
        <label className="mt-3 flex min-h-12 items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm">
          <input
            type="checkbox"
            checked={evidenceViewed}
            onChange={(e) => setEvidenceViewed(e.target.checked)}
            className="size-4 shrink-0"
          />
          {t('sigEvidenceViewedLabel')}
        </label>
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-semibold text-muted-foreground" htmlFor="gate-sig-reason">
          {t('sigReasonLabel')}
        </label>
        <textarea
          id="gate-sig-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('sigReasonPlaceholder')}
          className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {error ? (
        <p
          className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-foreground"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          {t('gateTransitionError', { reason: error })}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <p className="text-center text-[11px] text-muted-foreground">{t('sigConsequenceNote')}</p>
        <div className={compact ? 'flex flex-col gap-2' : 'flex gap-2'}>
          <Button
            variant="outline"
            className={compact ? 'min-h-12 w-full gap-1.5' : 'min-h-12 flex-1 gap-1.5'}
            disabled={resolving}
            onClick={() => onReject(reason)}
          >
            <XCircle className="size-4" />
            {t('sigRequestChanges')}
          </Button>
          <Button
            className={compact ? 'min-h-12 w-full gap-1.5' : 'min-h-12 flex-[1.4] gap-1.5'}
            disabled={!canSign}
            onClick={() => onApprove(reason)}
          >
            <CheckCircle className="size-4" />
            {resolving ? '...' : t('sigApproveAndSign')}
          </Button>
        </div>
      </div>
    </div>
  );
}
