'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Layers, X } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { getEntityHref } from '@/components/chat/embed-card';
import { EvidenceSection } from '@/components/verify/evidence-section';
import { ArtifactSection } from '@/components/canvas/artifact-section';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { deriveRiskLevel, usesSignatureFlow } from '@/components/cage/gate-risk';
import { GateSignatureApproval } from '@/components/cage/gate-signature-approval';
import { STATE_TEXT } from './work-list-row';
import type { WorkListRow } from './derive-work-list';
import {
  gateConversationId, primaryActionLabelKey, riskBadgeVariant, riskSentenceKey,
  type WorkListGate,
} from './work-list-detail-actions';

interface StoryDetail {
  self_reported: boolean | null;
  human_verified: boolean | null;
  human_verified_by: string | null;
  human_verified_at: string | null;
}

interface HypothesisSummary {
  id: string;
  statement: string;
  status: string;
}

interface DocBacklinkItem {
  id: string;
  doc: { id: string; title: string } | null;
  still_exists: boolean;
}

async function fetchJsonData<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T };
    return json.data ?? null;
  } catch {
    return null;
  }
}

/** story #3845 — findPendingInbox(derive-work-list.ts)와 동일 fallback(task 레벨 먼저,
 * 없으면 그 부모 story 레벨) — 다만 이 함수는 실 GateResponse 전체 필드(risk_grade·
 * gate_type·id)가 필요해 inbox 요약이 아니라 `/api/gates`를 직접 부른다. */
async function fetchPendingGate(row: WorkListRow, storyId: string): Promise<WorkListGate | null> {
  const tryFetch = async (workItemId: string, workItemType: string) => {
    const items = await fetchJsonData<WorkListGate[]>(
      `/api/gates?work_item_id=${workItemId}&work_item_type=${workItemType}&status=pending`,
    );
    return items && items.length > 0 ? items[0]! : null;
  };
  const direct = await tryFetch(row.workItemId, row.workItemType);
  if (direct) return direct;
  if (row.workItemType === 'task') return tryFetch(storyId, 'story');
  return null;
}

export interface WorkListDetailPanelProps {
  row: WorkListRow;
  storyId: string;
  storyTitle: string;
  goalTitle: string;
  onClose: () => void;
  className?: string;
  /** 픽셀 커밋 ①(페드루 PO 판정 2026-09-14 09:11Z) — 지금 필터 화면에는 이 행이 안 보이는지.
   * true면 안내 배너+필터 지우기 버튼을 띄운다("URL이 SSOT" — 필터로 가려져도 ?row= 딥링크는
   * 유효해야 한다). 미전달(undefined)이면 배너를 안 그린다(work-list-shell.tsx가 항상 넘기지만,
   * 다른 호출부가 생겨도 안전한 기본값). */
  isHiddenByFilter?: boolean;
  /** ①의 「필터 지우기」 버튼 핸들러 — isHiddenByFilter가 true일 때만 실제로 쓰인다. */
  onClearFilters?: () => void;
}

export function WorkListDetailPanel({
  row, storyId, storyTitle, goalTitle, onClose, className, isHiddenByFilter = false, onClearFilters,
}: WorkListDetailPanelProps) {
  const t = useTranslations('workList');
  const { currentMemberType } = useDashboardContext();

  const [story, setStory] = useState<StoryDetail | null>(null);
  const [hypotheses, setHypotheses] = useState<HypothesisSummary[]>([]);
  const [docs, setDocs] = useState<DocBacklinkItem[]>([]);
  const [gate, setGate] = useState<WorkListGate | null | undefined>(undefined); // undefined=로딩 중
  const [transitioning, setTransitioning] = useState(false);
  const [transitionError, setTransitionError] = useState<'forbidden' | 'other' | null>(null);
  const [approved, setApproved] = useState(false);

  const loadGate = useCallback(async () => {
    setGate(await fetchPendingGate(row, storyId));
  }, [row, storyId]);

  useEffect(() => {
    let cancelled = false;
    setStory(null);
    setHypotheses([]);
    setDocs([]);
    setGate(undefined);
    setTransitionError(null);
    setApproved(false);

    void fetchJsonData<StoryDetail>(`/api/stories/${storyId}`).then((v) => { if (!cancelled) setStory(v); });
    void fetchJsonData<HypothesisSummary[]>(`/api/hypotheses?story_id=${storyId}`).then((v) => { if (!cancelled) setHypotheses(v ?? []); });
    void fetchJsonData<DocBacklinkItem[]>(`/api/stories/${storyId}/backlinks?source_type=doc`).then((v) => { if (!cancelled) setDocs(v ?? []); });
    fetchPendingGate(row, storyId).then((v) => { if (!cancelled) setGate(v); }).catch(() => { if (!cancelled) setGate(null); });

    return () => { cancelled = true; };
  }, [row, storyId]);

  const stateText = row.state ? STATE_TEXT[row.state] : undefined;
  const riskKey = gate ? riskSentenceKey(gate) : null;
  const riskVariant = gate ? riskBadgeVariant(gate) : null;
  const labelKey = gate ? primaryActionLabelKey(gate) : null;
  const conversationId = gate ? gateConversationId(gate) : null;
  // 픽셀 커밋 ②(페드루 PO 판정 2026-09-14 09:11Z) — gates/[id]/page.tsx의 isSigFlowGate와
  // 정확히 같은 판정(usesSignatureFlow(deriveRiskLevel(gate))). primaryActionLabelKey가
  // 라벨을, 이 값이 «어느 UI를 그릴지»를 정한다 — 같은 SSOT에서 파생되므로 라벨과 실제
  // 렌더가 항상 짝을 이룬다(따로 계산하면 드리프트 위험).
  const isSigFlowGate = !!gate && usesSignatureFlow(deriveRiskLevel(gate));

  // story #3845 — 에이전트 뷰어는 버튼 자체를 안 보인다(403-회피, approvals-queue.tsx의
  // `currentMemberType === 'human'` 게이팅과 동일 SSOT — DashboardContext #2103).
  const canShowPrimaryAction = currentMemberType === 'human' && !!gate && !approved;

  const submitTransition = useCallback(async (status: 'approved' | 'rejected', evidenceViewed: boolean, note?: string) => {
    if (!gate) return;
    setTransitioning(true);
    setTransitionError(null);
    try {
      const res = await fetch(`/api/gates/${gate.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 픽셀 커밋 ②(페드루 PO 판정 2026-09-14 09:11Z, 정정) — evidence_viewed를 여기서
        // 하드코딩하지 않는다. 저위험(평문 버튼) 경로는 evidenceViewed=false로 호출되고,
        // 고위험(GateSignatureApproval) 경로는 그 컴포넌트의 onApprove가 호출될 때만
        // true로 호출된다 — 그 콜백 자체가 canSign=evidenceViewed&&reason(내부 체크박스+
        // 사유 textarea)로 게이팅돼 있어(gate-signature-approval.tsx), true를 여기서
        // 다시 검증할 필요 없이 "그 콜백이 불렸다"는 사실 자체가 "사람이 실제로 체크박스를
        // 봤다"는 증거다(gates/[id]/page.tsx의 동일 계약 그대로 재사용 — 새 근거열람
        // 추적을 이 패널이 독자로 만들지 않는다).
        body: JSON.stringify({ status, evidence_viewed: evidenceViewed, note: note ?? null }),
      });
      if (res.status === 403) { setTransitionError('forbidden'); return; }
      if (!res.ok) { setTransitionError('other'); return; }
      if (status === 'approved') setApproved(true);
      await loadGate();
    } catch {
      setTransitionError('other');
    } finally {
      setTransitioning(false);
    }
  }, [gate, loadGate]);

  // 저위험(평문) 경로 — evidence_viewed 없이(=false) 호출.
  const handlePlainApprove = useCallback(() => { void submitTransition('approved', false); }, [submitTransition]);
  // 고위험(서명) 경로 — GateSignatureApproval의 onApprove만 이 경로를 부른다.
  const handleSignedApprove = useCallback((reason: string) => { void submitTransition('approved', true, reason); }, [submitTransition]);
  // GateSignatureApproval은 onReject를 필수로 요구한다(그 컴포넌트의 「변경 요청」 버튼이
  // 항상 그려지므로) — 이 패널이 반려 흐름을 새로 설계하지 않되, 눌러도 아무 일도 안
  // 일어나는 죽은 버튼을 남기지 않도록 gates/[id]/page.tsx와 동일한 실 transition으로
  // 잇는다(evidence_viewed는 반려엔 의미 없어 false 고정).
  const handleReject = useCallback((reason: string) => { void submitTransition('rejected', false, reason); }, [submitTransition]);

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)} data-testid="work-list-detail-panel">
      <div className="flex items-start justify-between gap-2 border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{row.title}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground" data-testid="panel-belongs-to">
            {t('panelBelongsTo', { goal: goalTitle, story: storyTitle })}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" aria-label={t('panelClose')} onClick={onClose}>
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {/* 픽셀 커밋 ①(페드루 PO 판정 2026-09-14 09:11Z) — "URL이 SSOT": 필터로 안 보이는
          행이라도 ?row= 딥링크는 유효해야 한다("목록에 안 보이면 패널도 없다"는 같은
          화면 두 문장이 다른 세계가 되는 것 — URL은 선택했는데 화면은 무를 못 쓴다).
          data(필터 前 트리)에서 이 행을 찾아 패널은 항상 뜨고, filtered(화면에 보이는
          목록)에 없을 때만 이 배너로 그 사실을 알린다. */}
      {isHiddenByFilter ? (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-4 py-2" data-testid="panel-hidden-by-filter-notice">
          <p className="text-xs text-muted-foreground">{t('panelHiddenByFilter')}</p>
          <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" onClick={onClearFilters} data-testid="panel-clear-filters">
            {t('panelClearFilters')}
          </Button>
        </div>
      ) : null}

      <div className="overflow-y-auto focus-inset flex-1 space-y-3 p-4">
        <div className="space-y-1 text-xs">
          <p className="text-muted-foreground" data-testid="panel-assignee">
            {t('panelAssignee')}: <span className="text-foreground">{row.ownerName ?? t('panelAssigneeNone')}</span>
          </p>
          {stateText ? (
            <p className="text-muted-foreground" data-testid="panel-state">
              {t('panelState')}: <span className={cn('font-medium', stateText.className)}>{t(stateText.key)}</span>
            </p>
          ) : null}
        </div>

        {riskKey && riskVariant ? (
          <div className="flex items-center gap-2 rounded-md border border-border p-2" data-testid="panel-risk">
            <Badge variant={riskVariant}>{t(riskKey === 'riskSentenceHigh' ? 'riskBadgeHigh' : 'chipLowRisk')}</Badge>
            <p className="text-xs text-muted-foreground">{t(riskKey)}</p>
          </div>
        ) : null}

        {canShowPrimaryAction ? (
          <div className="space-y-2" data-testid="panel-primary-action-section">
            {/* 픽셀 커밋 ②(페드루 PO 판정 2026-09-14 09:11Z) — isSigFlowGate 분기는
                gates/[id]/page.tsx와 동형: 고위험은 GateSignatureApproval을 그대로
                재사용(근거열람 체크박스+사유 textarea를 이 패널이 재구현하지 않는다),
                저위험만 평문 버튼. */}
            {isSigFlowGate ? (
              <div data-testid="panel-signature-flow">
                <GateSignatureApproval
                  gate={gate!}
                  resolving={transitioning}
                  error={transitionError ? (transitionError === 'forbidden' ? t('transitionForbidden') : t('transitionError')) : null}
                  onApprove={handleSignedApprove}
                  onReject={handleReject}
                  compact
                />
              </div>
            ) : (
              <>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={transitioning}
                  onClick={handlePlainApprove}
                  data-testid="panel-primary-action"
                >
                  {t(labelKey!)}
                </Button>
                {transitionError === 'forbidden' ? (
                  <p className="text-xs text-destructive" data-testid="panel-transition-error">{t('transitionForbidden')}</p>
                ) : null}
                {transitionError === 'other' ? (
                  <p className="text-xs text-destructive" data-testid="panel-transition-error">{t('transitionError')}</p>
                ) : null}
              </>
            )}
            {conversationId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/chats/${conversationId}`} data-testid="panel-reply-action">{t('actionReply')}</Link>
              </Button>
            ) : null}
          </div>
        ) : null}
        {approved ? (
          <p className="text-xs text-success" data-testid="panel-approved-notice">{t('actionApproved')}</p>
        ) : null}

        <Tabs defaultValue="evidence" className="w-full">
          <TabsList className="w-full">
            <TabsTrigger value="evidence" className="flex-1" data-testid="panel-tab-evidence">{t('tabEvidence')}</TabsTrigger>
            <TabsTrigger value="docs" className="flex-1" data-testid="panel-tab-docs">{t('tabDocs')}</TabsTrigger>
            <TabsTrigger value="artifacts" className="flex-1" data-testid="panel-tab-artifacts">{t('tabArtifacts')}</TabsTrigger>
          </TabsList>

          <TabsContent value="evidence" className="mt-4 space-y-3">
            {hypotheses.length > 0 ? (
              <ul className="space-y-1.5" data-testid="panel-hypotheses-list">
                {hypotheses.map((h) => (
                  <li key={h.id} className="flex items-start gap-2 text-xs">
                    <Layers className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="text-foreground">{h.statement}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <EvidenceSection
              workItemId={storyId}
              workItemType="story"
              selfReported={story?.self_reported}
              humanVerified={story?.human_verified}
              humanVerifiedBy={story?.human_verified_by}
              humanVerifiedAt={story?.human_verified_at}
            />
          </TabsContent>

          <TabsContent value="docs" className="mt-4">
            {docs.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="panel-docs-empty">{t('panelEmptyDocs')}</p>
            ) : (
              <ul className="space-y-1.5" data-testid="panel-docs-list">
                {docs.filter((d) => d.doc !== null).map((d) => {
                  const href = getEntityHref('doc', d.doc!.id);
                  return (
                    <li key={d.id} className="flex items-center gap-2 text-xs">
                      <FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                      {href ? (
                        <a href={href} className="truncate text-primary underline-offset-2 hover:underline">{d.doc!.title}</a>
                      ) : (
                        <span className="truncate text-foreground">{d.doc!.title}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="artifacts" className="mt-4">
            <ArtifactSection storyId={storyId} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
