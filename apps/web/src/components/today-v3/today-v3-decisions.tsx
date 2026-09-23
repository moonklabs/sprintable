'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { hrefForNeedsMeItem, type TodayNeedsMeItem } from '@/components/org-briefing/derive-today';
import { buildGateTransitionBody, buildHitlDecisionBody, classifyGateTransitionErrorCode } from '@/lib/gate-decision-payload';
import { TodayV3ReasonDialog } from './today-v3-reason-dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { useFlatHref } from '@/hooks/use-flat-href';

/**
 * story #3964(E-UX-OVERHAUL·「오늘」 구현 4/N) — #3962/CHANGES-2가 지은 자리(위험
 * 등급 태그·저위험 모아 승인·개별 카드)에 실동작을 배선한다. AC1 그라운딩(페드루 PO
 * 확認 2026-09-16 16:15Z) 판정 3개가 이 파일의 분기를 결정한다:
 *  ① workflow_step 소스 = 자리만(클릭 0) — `record_parallel_decision`이 아직 라우터
 *    미배선(story #3334, 旣지식)이라 SoD/quorum 가드를 우회하는 직호출은 하지 않는다.
 *  ② 「보류」(gate hold) = admin/owner에게만 **보이고**(비활성이 아니라 숨김) 그 외
 *    role엔 렌더 자체를 안 한다.
 *  ③ hitl "답"은 API가 승인/반려(+선택 응답 텍스트)뿐 — 자유 서식 발명 0.
 *
 * 「서명」(고위험 gate 승인)은 여전히 `/gates/{id}` 상세로 링크한다(#3962와 동일) —
 * 그 페이지의 `GateSignatureApproval`은 근거 열람 강제(story #1954 AC, 안전 불변식)
 * 를 위해 완전한 `GateItem`(gate_type·evidence 등)이 필요한데, today의 `needs_me[]`
 * 는 그 필드들을 안 준다(new API round-trip 없이는 못 채운다) — 이 카드 스코프 밖.
 * 변경 요청(반려)·보류는 근거 열람이 불요해(단순 사유 입력) 인라인으로 짓는다.
 */

const ACTION_KEY: Record<TodayNeedsMeItem['state'], string> = {
  approval: 'actionApproveOnly',
  signature: 'actionApproveAndSign',
  answer: 'actionAnswerNow',
};

// story #3964 CHANGES(페드루 PO C1, 2026-09-16 16:37Z) — gate_already_resolved(남이
// 먼저 처리)는 "실패"가 아니라 원하던 결과(그 항목이 큐에서 사라짐)가 이미 일어난
// 것 — alreadyResolved를 별도로 실어 호출부가 재조회만 트리거하고 오류문장은
// 안 띄우게 한다. hold/hitl 엔드포인트는 이 코드 체계가 없어 항상 false.
interface ActionResult {
  ok: boolean;
  alreadyResolved: boolean;
}

async function postGateTransition(id: string, status: 'approved' | 'rejected', note?: string): Promise<ActionResult> {
  const res = await fetchWithAuth(`/api/gates/${id}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGateTransitionBody({ status, note })),
  });
  if (res.ok) return { ok: true, alreadyResolved: false };
  const body = await res.json().catch(() => null) as { error?: { code?: string } } | null;
  const alreadyResolved = classifyGateTransitionErrorCode(body?.error?.code) === 'already_resolved';
  return { ok: false, alreadyResolved };
}

async function postGateHold(id: string, reason?: string): Promise<ActionResult> {
  const res = await fetchWithAuth(`/api/gates/${id}/hold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason?.trim() || null }),
  });
  return { ok: res.ok, alreadyResolved: false };
}

async function patchHitlDecision(id: string, status: 'approved' | 'rejected', responseText?: string): Promise<ActionResult> {
  const res = await fetchWithAuth(`/api/v1/hitl-requests/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildHitlDecisionBody({ status, responseText: responseText || undefined })),
  });
  return { ok: res.ok, alreadyResolved: false };
}

type DialogKind = 'requestChanges' | 'hold';

function GateSignatureCard({ item, isAdminOrOwner, onDone }: {
  item: TodayNeedsMeItem; isAdminOrOwner: boolean; onDone: () => void;
}) {
  const t = useTranslations('todayV3');
  const tOrg = useTranslations('orgBriefing');
  const tc = useTranslations('common');
  const href = hrefForNeedsMeItem(item);
  const [dialogKind, setDialogKind] = useState<DialogKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const submitDialog = async (reason: string) => {
    setBusy(true);
    setDialogError(null);
    const result = dialogKind === 'hold'
      ? await postGateHold(item.id, reason)
      : await postGateTransition(item.id, 'rejected', reason);
    setBusy(false);
    if (result.ok || result.alreadyResolved) { setDialogKind(null); onDone(); } else { setDialogError(t('decisionActionFailed')); }
  };

  return (
    <Card className="p-3.5" data-testid="today-v3-decision-card">
      <div className="mb-1.5 flex items-center gap-2">
        <Badge variant="warning" data-testid="today-v3-decision-tag">{t('tagHighRisk')}</Badge>
      </div>
      <p className="text-[14.5px] font-medium text-foreground">{item.workItemTitle}</p>
      {item.requestedByName ? (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{tOrg('needsMeMetaRequestedBy', { name: item.requestedByName })}</p>
      ) : null}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button asChild size="sm">
          <Link href={href}>{tOrg(ACTION_KEY.signature)}</Link>
        </Button>
        <Button
          size="sm" variant="outline" disabled={busy}
          onClick={() => setDialogKind('requestChanges')}
          data-testid="today-v3-request-changes-action"
        >
          {t('actionRequestChanges')}
        </Button>
        {isAdminOrOwner ? (
          <Button
            size="sm" variant="outline" disabled={busy}
            onClick={() => setDialogKind('hold')}
            data-testid="today-v3-hold-action"
          >
            {t('actionHold')}
          </Button>
        ) : null}
      </div>
      <TodayV3ReasonDialog
        open={dialogKind !== null}
        onOpenChange={(next) => { if (!next) { setDialogKind(null); setDialogError(null); } }}
        title={dialogKind === 'hold' ? t('reasonDialogHoldTitle') : t('reasonDialogRequestChangesTitle')}
        placeholder={dialogKind === 'hold' ? t('reasonDialogHoldPlaceholder') : t('reasonDialogRequestChangesPlaceholder')}
        submitLabel={dialogKind === 'hold' ? t('actionHold') : t('actionRequestChanges')}
        cancelLabel={tc('cancel')}
        reasonRequired={dialogKind === 'requestChanges'}
        submitting={busy}
        error={dialogError}
        onSubmit={submitDialog}
      />
    </Card>
  );
}

function HitlAnswerCard({ item, onDone }: { item: TodayNeedsMeItem; onDone: () => void }) {
  const t = useTranslations('todayV3');
  const [responseText, setResponseText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (status: 'approved' | 'rejected') => {
    setBusy(true);
    setError(null);
    const result = await patchHitlDecision(item.id, status, responseText);
    setBusy(false);
    if (result.ok) onDone(); else setError(t('decisionActionFailed'));
  };

  return (
    <Card className="p-3.5" data-testid="today-v3-decision-card">
      <div className="mb-1.5 flex items-center gap-2">
        <Badge variant="info" data-testid="today-v3-decision-tag">{t('tagQuestion')}</Badge>
      </div>
      <p className="text-[14.5px] font-medium text-foreground">{item.workItemTitle}</p>
      {item.reason ? <p className="mt-0.5 text-xs text-muted-foreground">{item.reason}</p> : null}
      <Input
        value={responseText}
        onChange={(e) => setResponseText(e.target.value)}
        placeholder={t('hitlResponsePlaceholder')}
        aria-label={t('hitlResponsePlaceholder')}
        className="mt-2 h-8 text-xs"
        data-testid="today-v3-hitl-response-input"
      />
      {error ? <p role="alert" className="mt-1.5 text-xs text-destructive">{error}</p> : null}
      <div className="mt-2.5 flex gap-1.5">
        <Button size="sm" disabled={busy} onClick={() => decide('approved')} data-testid="today-v3-hitl-approve-action">
          {t('actionApproveHitl')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => decide('rejected')} data-testid="today-v3-hitl-reject-action">
          {t('actionRejectHitl')}
        </Button>
      </div>
    </Card>
  );
}

// story #4190(유나 «본 버전 대조» 2) — 저위험 일괄에서 뺀 레시피 발행 게이트의 개별 카드. 고위험 카드와 같은 틀(제목·
// 요청자)에 주 버튼 하나(«초안 보고 승인» → 초안 카드가 있는 게이트 상세). «고위험» 태그는 사실이 아니라 붙이지 않고,
// 변경 요청·보류도 두지 않는다(초안을 보고 게이트 상세에서 판단할 일).
function RecipeDraftReviewCard({ item }: { item: TodayNeedsMeItem }) {
  const tOrg = useTranslations('orgBriefing');
  const tCage = useTranslations('cage');
  const flatHref = useFlatHref(); // story #4226 — flat 링크 `?p=`
  return (
    <Card className="p-3.5" data-testid="today-v3-decision-card">
      <p className="text-[14.5px] font-medium text-foreground">{item.workItemTitle}</p>
      {item.requestedByName ? (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{tOrg('needsMeMetaRequestedBy', { name: item.requestedByName })}</p>
      ) : null}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button asChild size="sm">
          <Link href={flatHref(`/gates/${item.id}`)} data-testid="today-v3-recipe-review-draft-action">{tCage('gateReviewDraftToApprove')}</Link>
        </Button>
      </div>
    </Card>
  );
}

// story #3964 ① — workflow_step은 실동작 엔드포인트가 없다(그라운딩 참고). 클릭 0
// (비활성 버튼)·「곧 돼요」류 문구는 짓지 않는다(기존 액션 라벨을 그대로 비활성 표시).
function WorkflowStepPlaceholderCard({ item }: { item: TodayNeedsMeItem }) {
  const tOrg = useTranslations('orgBriefing');
  return (
    <Card className="p-3.5" data-testid="today-v3-decision-card">
      <p className="text-[14.5px] font-medium text-foreground">{item.workItemTitle}</p>
      <div className="mt-2.5">
        <Button size="sm" disabled data-testid="today-v3-workflow-step-placeholder-action">
          {tOrg(ACTION_KEY[item.state])}
        </Button>
      </div>
    </Card>
  );
}

export function TodayV3Decisions({ items, count, isAdminOrOwner, onActionSuccess }: {
  items: TodayNeedsMeItem[];
  count: number;
  isAdminOrOwner: boolean;
  onActionSuccess: () => void;
}) {
  const t = useTranslations('todayV3');
  const workflowStep = items.filter((i) => i.source === 'workflow_step');
  const individual = items.filter((i) => i.source !== 'workflow_step' && (i.risk === 'high' || i.state === 'answer'));
  // story #4190(유나) — 레시피 발행 게이트는 초안을 보고 승인해야 해 일괄에서 뺀다 — «저위험 {count}건»도 뺀 뒤의 수
  // (줄의 수 = 버튼이 실제로 승인하는 수).
  const lowRiskCandidates = items.filter((i) => i.source !== 'workflow_step' && i.risk === 'low' && i.state !== 'answer');
  const recipeDraftReview = lowRiskCandidates.filter((i) => i.recipePublish);
  const lowRiskBulk = lowRiskCandidates.filter((i) => !i.recipePublish);

  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // story #3964 AC3 — low만 순차 전이(고위험·workflow_step은 lowRiskBulk 자체에 안 들어온다,
  // 필터가 이미 배제 — 새 벌크 엔드포인트 0). 부분 실패는 센 뒤 문장으로.
  const runBulkApprove = async () => {
    setBulkBusy(true);
    setBulkError(null);
    let failures = 0;
    for (const item of lowRiskBulk) {
      const result = item.source === 'hitl'
        ? await patchHitlDecision(item.id, 'approved')
        : await postGateTransition(item.id, 'approved');
      if (!result.ok && !result.alreadyResolved) failures += 1;
    }
    setBulkBusy(false);
    if (failures > 0) setBulkError(t('bulkApprovePartialFailure', { failed: failures, total: lowRiskBulk.length }));
    onActionSuccess();
  };

  return (
    <section aria-label={t('decisionsSectionTitle', { count })} data-testid="today-v3-decisions-section">
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold text-foreground">{t('decisionsSectionTitle', { count })}</h2>
      </div>
      {items.length === 0 ? (
        <Card className="flex flex-col items-center gap-1.5 px-5 py-10 text-center">
          <p className="text-sm font-medium text-foreground">{t('decisionsEmptyTitle')}</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {individual.map((item) => (
            item.state === 'answer'
              ? <HitlAnswerCard key={item.id} item={item} onDone={onActionSuccess} />
              : <GateSignatureCard key={item.id} item={item} isAdminOrOwner={isAdminOrOwner} onDone={onActionSuccess} />
          ))}
          {recipeDraftReview.map((item) => <RecipeDraftReviewCard key={item.id} item={item} />)}
          {workflowStep.map((item) => <WorkflowStepPlaceholderCard key={item.id} item={item} />)}
          {lowRiskBulk.length > 0 ? (
            <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/50 px-3.5 py-2.5" data-testid="today-v3-low-risk-row">
              <div className="flex items-center gap-2.5">
                <span className="text-[13px] text-foreground">{t('lowRiskGroupedLine', { count: lowRiskBulk.length })}</span>
                <Button
                  size="sm" variant="outline" className="ml-auto" disabled={bulkBusy}
                  onClick={runBulkApprove} data-testid="today-v3-bulk-approve-action"
                >
                  {t('bulkApproveAction')}
                </Button>
              </div>
              {bulkError ? <p role="alert" className="text-xs text-destructive">{bulkError}</p> : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
