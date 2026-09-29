'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GateEvidence } from '@/components/cage/gate-evidence';
import type { GateItem } from '@/components/kanban/types';
import { sigApproveAndSignLabelKey } from '@/lib/newsletter-gate-approve-label';
import { reviewedDraftOf } from '@/components/cage/gate-risk';
import { useFieldDraft } from '@/hooks/use-field-draft';

/** 부르는 쪽이 성공을 알리면(Promise<true>) 초안을 지운다 — 돌려주는 값이 없거나 false면 남긴다(story #4370). */
type SignatureAction = (reason: string) => void | Promise<boolean | void>;

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
  onDiscuss,
  compact = false,
  onCancel,
}: {
  gate: GateItem;
  resolving: boolean;
  // story #2043 AC3: 서버 거부 사유(예: 고위험 승인 note 필수 422)를 사람이 읽을 문구로.
  // "버튼 비활성"만으로는 왜 막혔는지가 안 보여 AC 미충족 — 이 화면은 근거 열람+사유 입력
  // 이후에나 버튼이 풀리므로, 서버 거부는 클라이언트 검증을 통과했는데도 막힌 경우라 더더욱
  // 이유를 보여줘야 한다.
  error?: string | null;
  onApprove: SignatureAction;
  onReject: SignatureAction;
  /** story #2631(FE 계약 doc bb733f26) — «보류(논의 필요)». 승인/반려와 같은 사유 입력을
   * 공유한다(별도 모달 불필요 — 이미 이 화면에 사유 textarea가 있다). 미전달 시(#2043
   * 기존 소비처가 아직 업데이트 안 된 경우 등) 버튼 자체를 안 그린다 — 회귀 없음. */
  onDiscuss?: SignatureAction;
  /** story #2625(유나 design 확定, 카디르 QA 320px 실측 대응) — 챗 카드 좁은 폭(실효 ~166px)
   * 컨텍스트. 원 컨텍스트(gates 페이지 672px)는 가로 2버튼이 여유롭지만, 좁은 폭에서
   * whitespace-nowrap+shrink-0(button.tsx 기본) 그대로면 라벨이 잘린다. truncate나
   * 아이콘-only는 금지(중대 액션 라벨 온전 필수, PO 확定) — 대신 세로 스택으로 각 버튼이
   * full-width를 갖게 한다. 컴포넌트를 포크하지 않고 이 prop 하나로 컨텍스트만 분기한다. */
  compact?: boolean;
  /** story #4370(까디르 P3) — 보이는 «취소»(저위험 게이트의 «변경 요청» 패널에서 원탭 승인 화면으로 되돌아가기). 사유 초안을 지우고
   * 부른다(유나 규칙: 버림은 보이는 «취소»로만). 없으면 버튼을 안 그린다(고위험은 이 패널이 유일한 길이라 취소 없음). */
  onCancel?: () => void;
}) {
  const t = useTranslations('cage');
  // story #3813(Phase3·3-4 PR4, 페드루 PO CHANGES 2026-09-12, 라이브 캡처 실측) — 이
  // 버튼이 사람이 실제로 누르는 primary(고위험 게이트는 이 서명 플로우가 뜬다,
  // gates/[id]/page.tsx의 평문 버튼은 저위험 전용) — 처음 처방이 평문 버튼에만
  // 붙어 정작 여기엔 「승인하고 서명」이 그대로 남아 있었다.
  const approveAndSignLabelKey = sigApproveAndSignLabelKey(gate);
  // story #4370 — 사유는 게이트 + 검토 대상(머리 SHA · 초안 버전)별 초안: 닫히거나 떠나도 남고 결재 성공에서만 지운다.
  // 검토 대상이 바뀌면 키가 바뀌어 빈 칸(story #4190 — 새 버전은 다시 보고 서명).
  const draftTarget = `${gate.id}:${gate.github_check_run_sha ?? ''}:${reviewedDraftOf(gate)?.version ?? ''}`;
  // 확인 체크(유나 규칙 · 까디르 P2)는 초안이 아니다. 검토 대상(게이트 · SHA · 버전)이 바뀌면 — 부르는 쪽 key가 무엇이든,
  // 같은 컴포넌트가 다시 쓰여도 — 체크를 버린다(돌아와도 다시 보고 체크). 그린 동안 이전 대상과 비교해 되돌리는 React 권장 모양.
  const [evidenceViewed, setEvidenceViewed] = useState(false);
  const [shownTarget, setShownTarget] = useState(draftTarget);
  if (shownTarget !== draftTarget) {
    setShownTarget(draftTarget);
    setEvidenceViewed(false);
  }
  const [reason, setReason, clearReason] = useFieldDraft({ surface: 'gate-signature', targetId: draftTarget, field: 'form' });
  const act = (action: SignatureAction) => {
    const result = action(reason);
    if (result && typeof (result as Promise<boolean | void>).then === 'function') {
      void (result as Promise<boolean | void>).then((ok) => { if (ok === true) clearReason(); });
    }
  };
  const canSign = evidenceViewed && reason.trim().length > 0 && !resolving;
  // discuss는 근거 열람 불필요(승인이 아니므로) — 사유만 있으면 된다.
  const canDiscuss = reason.trim().length > 0 && !resolving;
  // story #3334(선생님 실사용 4바퀴 T1' 적출) — 반려(변경 요청)는 근거 열람과 무관하게(승인이
  // 아니므로 canSign과 다른 축) 사유만 필수. 예전엔 이 버튼이 resolving만 봐서 사유 빈 채로도
  // 즉시 제출됐다(서버도 무검증이라 그대로 저장 — 반려 통지가 사유 없이 나감, #3330 AC2 무력화).
  const canReject = reason.trim().length > 0 && !resolving;

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
          className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-base lg:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {error ? (
        <p
          className="break-keep rounded-lg border border-destructive/30 bg-destructive-tint px-3 py-2 text-xs text-foreground"
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
            disabled={!canReject}
            onClick={() => act(onReject)}
          >
            <Pencil className="size-4" />
            {t('sigRequestChanges')}
          </Button>
          <Button
            className={compact ? 'min-h-12 w-full gap-1.5' : 'min-h-12 flex-[1.4] gap-1.5'}
            disabled={!canSign}
            onClick={() => act(onApprove)}
          >
            <CheckCircle className="size-4" />
            {resolving ? '...' : t(approveAndSignLabelKey)}
          </Button>
        </div>
        {onDiscuss ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            disabled={!canDiscuss}
            onClick={() => act(onDiscuss)}
          >
            {t('gateDiscussSubmit')}
          </Button>
        ) : null}
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            disabled={resolving}
            onClick={() => { clearReason(); onCancel(); }}
          >
            {t('cancel')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
