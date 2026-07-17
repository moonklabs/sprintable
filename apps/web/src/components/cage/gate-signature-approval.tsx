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
  onApprove,
  onReject,
}: {
  gate: GateItem;
  resolving: boolean;
  onApprove: (reason: string) => void;
  onReject: (reason: string) => void;
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
          className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-center text-[11px] text-muted-foreground">{t('sigConsequenceNote')}</p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="min-h-12 flex-1 gap-1.5"
            disabled={resolving}
            onClick={() => onReject(reason)}
          >
            <XCircle className="size-4" />
            {t('sigRequestChanges')}
          </Button>
          <Button
            className="min-h-12 flex-[1.4] gap-1.5"
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
