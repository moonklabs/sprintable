'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { TodayAgentProgressItem } from '@/components/org-briefing/derive-today';
import { TodayV3ReasonDialog } from './today-v3-reason-dialog';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #3970(E-UX-OVERHAUL·「오늘」 구현 5/N) — #3962/CHANGES-2가 지은 「정지」
 * 자리에 실동작을 배선한다. BE 계약(story #3961, PR #4364·PO PASS·미착지 diff
 * 직접 인용):
 *  - 취소 가능 status(agent_runs.py 인용, `_CANCELLABLE_STATUSES`) = queued·held·
 *    running·hitl_pending(cancel_requested 자신은 제외).
 *  - `POST /api/v2/agent-runs/{id}/cancel` body `{reason?: string|null}` →
 *    `AgentRunResponse`(status=cancel_requested).
 *  - 403 = 권한 없음(비-human 호출자·org owner/admin도 story assignee/human_owner
 *    도 아님) · 409 = 이미 취소 불가 상태(종결됐거나 이미 요청됨).
 *  - today_service.py도 함께 갱신돼(#4364) `cancel_requested`가 "진행 中" 집합에
 *    남고(§AgentProgressItem.cancel 필드) 그 값이 non-null이면 이미 요청된 것.
 *
 * base=develop(페드루 PO 지시, #4365/#4367에 안 얹음) — 이 파일·같은 디렉터리의
 * `today-v3-reason-dialog.tsx`는 #3962/#3964 브랜치의 현재 내용을 그대로 복제해
 * develop에 새로 얹는다(그 두 PR이 아직 안 머지돼 develop엔 today-v3 디렉터리
 * 자체가 없다) — 착지 순서에 따라 rebase 1회가 필요함을 PR 본문에 明示.
 */

const CANCELLABLE_STATUSES = new Set(['queued', 'held', 'running', 'hitl_pending']);

async function postCancelRun(runId: string, reason?: string): Promise<{ ok: true } | { ok: false; status: number }> {
  const res = await fetchWithAuth(`/api/agent-runs/${runId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason?.trim() || null }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, status: res.status };
}

function AgentProgressRow({ item, onDone }: { item: TodayAgentProgressItem; onDone: () => void }) {
  const t = useTranslations('todayV3');
  const tc = useTranslations('common');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (reason: string) => {
    setBusy(true);
    setError(null);
    const result = await postCancelRun(item.runId, reason);
    setBusy(false);
    if (result.ok) {
      setDialogOpen(false);
      onDone();
    } else if (result.status === 409) {
      // story #3970 — 이미 종결됐거나 이미 요청됨(서버 진실 반영) — 실패가 아니라
      // 재조회로 흡수한다(#3964 gate_already_resolved와 같은 결).
      setDialogOpen(false);
      onDone();
    } else if (result.status === 403) {
      setError(t('stopActionForbidden'));
    } else {
      setError(t('decisionActionFailed'));
    }
  };

  const isCancellable = item.cancel === null && CANCELLABLE_STATUSES.has(item.status);
  const isCancelRequested = item.cancel !== null;

  return (
    <div className="flex items-center gap-3 border-t border-border px-3 py-3 first:border-t-0" data-testid="today-v3-agent-progress-row">
      <span className="size-2 shrink-0 rounded-full bg-info" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-foreground">
          {item.workItemTitle ?? item.agentName}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{item.agentName}</span>
        {error ? <span role="alert" className="block text-xs text-destructive">{error}</span> : null}
      </div>
      {isCancelRequested ? (
        <span className="shrink-0 text-xs text-muted-foreground" data-testid="today-v3-stop-requested-label">
          {t('stopRequestedLabel')}
        </span>
      ) : (
        <Button
          size="sm" variant="outline" disabled={!isCancellable || busy}
          onClick={() => setDialogOpen(true)}
          className="shrink-0 text-xs"
          data-testid="today-v3-stop-action"
        >
          {t('stopAction')}
        </Button>
      )}
      <TodayV3ReasonDialog
        open={dialogOpen}
        onOpenChange={(next) => { if (!next) { setDialogOpen(false); setError(null); } }}
        title={t('reasonDialogStopTitle')}
        placeholder={t('reasonDialogStopPlaceholder')}
        submitLabel={t('stopAction')}
        cancelLabel={tc('cancel')}
        reasonRequired={false}
        submitting={busy}
        error={error}
        onSubmit={submit}
      />
    </div>
  );
}

export function TodayV3AgentProgress({ items, onActionSuccess }: {
  items: TodayAgentProgressItem[];
  onActionSuccess: () => void;
}) {
  const t = useTranslations('todayV3');
  return (
    <section aria-label={t('progressSectionTitle', { count: items.length })} data-testid="today-v3-progress-section">
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold text-foreground">{t('progressSectionTitle', { count: items.length })}</h2>
      </div>
      {items.length === 0 ? (
        <Card className="flex flex-col items-center gap-1.5 px-5 py-10 text-center">
          <p className="text-sm font-medium text-foreground">{t('progressEmptyTitle')}</p>
        </Card>
      ) : (
        <Card>{items.map((item) => <AgentProgressRow key={item.runId} item={item} onDone={onActionSuccess} />)}</Card>
      )}
    </section>
  );
}
