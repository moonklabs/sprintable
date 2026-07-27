'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { Hypothesis } from '@sprintable/core-storage';

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export interface HypothesisResolveResult {
  actual: number;
  reason: string;
  target: 'verified' | 'falsified';
}

/**
 * story #2036 — 검증 중(measuring) 가설을 사람이 달성/반증으로 닫는 유일한 표면.
 * AC2: 실제 수치 + 한 줄 근거 둘 다 없으면 제출 불가(근거 없는 "달성" 버튼=조직 자기기만 통로).
 * 반증(falsify)도 같은 폼 구조 — soul-lock(§hypothesis-status-badge.tsx): 반증을 실패처럼
 * 취급하는 문구/색 금지, 담담한 "판정 저장" 톤 유지.
 *
 * 유나 가디언 리뷰(PR #2303) 수정요청: 목표 미달 수치를 입력해도 "달성"으로 조용히 저장되는
 * 통로가 있었다 — 목표(target)를 화면에 보여주면서 불일치를 막지 않은 게 문제. 차단하지 않고
 * (측정 방식 변경·정성 판단 등 정당한 override 사유가 있을 수 있음 — 근거 필드가 그 자리)
 * 불일치를 인지시키는 방향으로: 입력값이 현재 판정 조건과 안 맞으면 배너+반대 판정 전환 버튼.
 *
 * AC8(오르테가 PO 판정, hypothesis.py `_VALID_TRANSITIONS`로 확인): measuring→verified|falsified는
 * archived로만 전진하고 active/measuring으로 역전이 불가("새 가설을 만든다") — 되돌릴 수 없는
 * 종결이라 브랜드 블루를 종결 버튼에 둔다. 유나 가디언 2차 검수(2026-07-20): 이전엔 Button
 * 기본 variant(--primary)에 기댔는데, §4-1이 "브랜드 블루=인간이 서명한 자리"라고 색을
 * 토큰명으로 특정하므로 `bg-brand`를 명시한다 — --primary와 --brand가 지금 같은 값이라는
 * 우연에 기대면 둘이 갈릴 때 조용히 깨진다(그 둘이 왜 같은 값인지는 별건, 여기서 안 건드림).
 */
export function HypothesisResolveDialog({
  hypothesis,
  target: initialTarget,
  submitting,
  onSubmit,
  onCancel,
}: {
  hypothesis: Hypothesis;
  target: 'verified' | 'falsified';
  submitting: boolean;
  onSubmit: (result: HypothesisResolveResult) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('hypotheses');
  const md = hypothesis.metric_definition;
  const [verdict, setVerdict] = useState<'verified' | 'falsified'>(initialTarget);
  const [actual, setActual] = useState('');
  const [reason, setReason] = useState('');

  const actualNum = actual.trim() === '' ? null : Number(actual);
  const canSubmit = actualNum !== null && !Number.isNaN(actualNum) && reason.trim().length > 0 && !submitting;
  const isVerify = verdict === 'verified';

  // 유나 가디언 수정요청 — 입력값이 현재 선택된 판정의 목표 조건과 맞는지. null=판단 불가(입력 전
  // 또는 target 없음), true/false=충족 여부. mismatch면 저장을 막지 않고 배너로만 알린다.
  const meetsTarget = actualNum !== null && !Number.isNaN(actualNum) && typeof md?.target === 'number'
    ? (md.direction === 'down' ? actualNum <= md.target : actualNum >= md.target)
    : null;
  const mismatch = meetsTarget !== null && meetsTarget !== isVerify;

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onCancel(); }}>
      {/* 유나 가디언 확定 규격(2026-07-20): 폭 384px(sm:max-w-sm 기본값)→480~520px(sm:max-w-lg=512px),
          다이얼로그 전체는 max-h-[85vh]+세로 flex로 상한을 두고 overflow는 안전망으로만 남긴다.
          "문장만 스크롤"이 핵심 — 문장 영역(아래 statement wrapper)만 자체 overflow-y-auto를
          갖고 입력·푸터는 그 흐름 밖(shrink-0)에 남아 화면 밖으로 밀리지 않는다. */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>{isVerify ? t('resolveTitleVerify') : t('resolveTitleFalsify')}</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) onSubmit({ actual: actualNum as number, reason: reason.trim(), target: verdict });
          }}
        >
          {/* 유나 가디언 실측 지적(2026-07-20): line-clamp-3가 문장을 잘라 "무엇에 서명하는지"가
              안 보였다(사람이 책임지고 닫는 화면인데 대상이 안 보임). 클램프를 풀되 극단적으로
              긴 가설이 다이얼로그 전체를 밀어 입력/버튼을 화면 밖으로 내보내지 않도록, 문장
              영역 자체에 상한(max-h-[40vh])+자체 스크롤을 둬 폼의 나머지(입력·근거·버튼)는
              항상 고정 위치에 남는다 — "서명 못 하는 상태"가 되지 않는다. */}
          <div className="max-h-[40vh] min-h-0 overflow-y-auto rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-sm leading-6 text-foreground">{hypothesis.statement}</p>
          </div>

          {md?.metric ? (
            <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
              📈 {md.metric} {md.direction === 'down' ? '≤' : '≥'} {fmt(md.target)}
            </p>
          ) : null}

          <div className="shrink-0 space-y-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="resolve-actual">
              {/* 유나 가디언 지적(2026-07-20): text-destructive(빨강)는 §4-3에서 "되돌릴 수 없는
                  파괴"에 묶인 신호값 — 필수 입력 표시는 파괴가 아니라서 여기 쓰면 진짜 파괴 자리의
                  신호가 깎인다. `*` 자체는 유지하되 중립색(muted)으로. */}
              {t('actualInputLabel')} <span className="text-muted-foreground">*</span>
            </label>
            <input
              id="resolve-actual"
              type="number"
              inputMode="decimal"
              value={actual}
              onChange={(e) => setActual(e.target.value)}
              // 유나 가디언 지적(2026-07-20): targetPlaceholder("12", 목표 입력용 예시값)를
              // 재사용해왔던 게 원인 — 대비가 진해(4.83:1) 빈 입력을 "이미 12를 입력한 화면"으로
              // 오독시켰다(불일치 배너가 왜 안 뜨냐는 검수 질문까지 나옴). 종결 다이얼로그 전용
              // placeholder 키를 신설.
              placeholder={t('resolveActualPlaceholder')}
              autoFocus
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          {mismatch ? (
            <div className="flex shrink-0 items-start gap-2 rounded-lg border border-warning-border bg-warning-tint px-3 py-2 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <div className="space-y-1">
                <p>{isVerify ? t('mismatchVerifyWarning') : t('mismatchFalsifyWarning')}</p>
                <button
                  type="button"
                  onClick={() => setVerdict(isVerify ? 'falsified' : 'verified')}
                  className="font-medium underline underline-offset-2"
                >
                  {isVerify ? t('switchToFalsify') : t('switchToVerify')}
                </button>
              </div>
            </div>
          ) : null}

          <div className="shrink-0 space-y-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="resolve-reason">
              {t('reasonInputLabel')} <span className="text-muted-foreground">*</span>
            </label>
            <input
              id="resolve-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonInputPlaceholder')}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {/* 힌트는 유지(PO 지시) — "제품이 파는 것을 직접 말해주는 자리"라 3중 반복이어도 값어치가 큼. */}
            <p className="text-[11px] text-muted-foreground">{t('reasonHint')}</p>
          </div>

          <DialogFooter className="shrink-0">
            <DialogClose render={<Button type="button" variant="ghost" disabled={submitting} onClick={onCancel}>{t('cancel')}</Button>} />
            <Button type="submit" disabled={!canSubmit} className="bg-brand text-brand-foreground hover:bg-brand/90">
              {submitting ? t('saving') : t('resolveSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
