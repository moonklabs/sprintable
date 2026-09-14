'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Layers, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { getEntityHref } from '@/components/chat/embed-card';
import { EvidenceSection } from '@/components/verify/evidence-section';
import { ArtifactSection } from '@/components/canvas/artifact-section';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
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
}

export function WorkListDetailPanel({ row, storyId, storyTitle, goalTitle, onClose, className }: WorkListDetailPanelProps) {
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

  // story #3845 — 에이전트 뷰어는 버튼 자체를 안 보인다(403-회피, approvals-queue.tsx의
  // `currentMemberType === 'human'` 게이팅과 동일 SSOT — DashboardContext #2103).
  const canShowPrimaryAction = currentMemberType === 'human' && !!gate && !approved;

  const handleApprove = useCallback(async () => {
    if (!gate) return;
    setTransitioning(true);
    setTransitionError(null);
    try {
      const res = await fetch(`/api/gates/${gate.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // story #3845 — evidence_viewed=true: 이 패널이 열려 있으면 근거 탭이 항상 함께
        // 보이므로(같은 화면·같은 클릭 흐름) "봤다"는 최소 사실을 서버가 요구하는 그대로
        // 보낸다. 고위험 게이트는 서버가 이 값 없이는 거절한다(gates.py GateTransitionRequest
        // 주석 — «봤다»는 서버가 관측할 수 없는 값이라 UI 경유를 강제하는 최소 방어선).
        body: JSON.stringify({ status: 'approved', evidence_viewed: true }),
      });
      if (res.status === 403) { setTransitionError('forbidden'); return; }
      if (!res.ok) { setTransitionError('other'); return; }
      setApproved(true);
      await loadGate();
    } catch {
      setTransitionError('other');
    } finally {
      setTransitioning(false);
    }
  }, [gate, loadGate]);

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
          <div className="space-y-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={transitioning}
              onClick={() => void handleApprove()}
              data-testid="panel-primary-action"
            >
              {t(labelKey!)}
            </Button>
            {conversationId ? (
              <Button type="button" variant="outline" size="sm" data-testid="panel-reply-action">
                {t('actionReply')}
              </Button>
            ) : null}
            {transitionError === 'forbidden' ? (
              <p className="text-xs text-destructive" data-testid="panel-transition-error">{t('transitionForbidden')}</p>
            ) : null}
            {transitionError === 'other' ? (
              <p className="text-xs text-destructive" data-testid="panel-transition-error">{t('transitionError')}</p>
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
