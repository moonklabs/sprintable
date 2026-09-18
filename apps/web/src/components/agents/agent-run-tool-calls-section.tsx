'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CountBadge } from '@/components/ui/count-badge';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';
import { formatDuration, toLocaleStr } from './agent-run-detail';
import type { AgentRunStatus } from '@/lib/agent-run-status';

// story #3722(Trust·PR2) — 確定 설계(PO 05:52Z)의 "Timeline+Tool Audit Trail 재건" 대상.
// PO 2026-09-09 09:13Z 決: 옛 화면이 같은 tool_call_history를 두 판(연대기·감사표)으로
// 그렸을 뿐 소스가 하나였다 — 단일 통합 섹션으로 합친다(같은 데이터를 두 번 안 보여준다).
interface ToolCallRow {
  id: string;
  tool: string | null;
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  started_at: string;
  created_at: string;
  input_summary: Record<string, unknown> | null;
  error: string | null;
  attribution_reason: string;
}

const LIMIT = 50;

function isSuccessStatus(statusCode: number): boolean {
  return statusCode < 400;
}

export function AgentRunToolCallsSection({
  runId,
  runStatus,
  locale,
  displayTimezone,
}: {
  runId: string;
  runStatus: AgentRunStatus;
  locale: string;
  displayTimezone: string;
}) {
  const t = useTranslations('agentRuns');
  const [rows, setRows] = useState<ToolCallRow[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        const res = await fetchWithAuth(`/api/v1/agent-runs/${runId}/tool-calls?limit=${LIMIT}`);
        const json = res.ok ? await res.json() : null;
        if (cancelled) return;
        if (res.ok && json) {
          setRows(Array.isArray(json.data) ? json.data : []);
          setTotalCount(typeof json.meta?.totalCount === 'number' ? json.meta.totalCount : null);
        } else {
          setLoadError(true);
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [runId]);

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const cursor = encodeURIComponent(last.created_at);
      const res = await fetchWithAuth(`/api/v1/agent-runs/${runId}/tool-calls?limit=${LIMIT}&cursor=${cursor}`);
      if (res.ok) {
        const json = await res.json();
        const more: ToolCallRow[] = Array.isArray(json.data) ? json.data : [];
        setRows((prev) => [...prev, ...more]);
        if (typeof json.meta?.totalCount === 'number') setTotalCount(json.meta.totalCount);
      }
    } catch {
      // story #1989 — 로딩 실패는 목록을 비우지 않는다(이미 있는 행은 유지, 재시도는 버튼 재클릭).
    } finally {
      setLoadingMore(false);
    }
  };

  // story #3722 — 빈 상태 두 사실을 가른다(유나 판정 축③): run이 아직 안 끝났으면(기록이
  // 늦게 붙을 수 있음) "아직 기록이 없습니다", 끝났으면(더 안 늘어남이 확실) "도구를 안
  // 썼습니다" — 서버가 관측 못 한 것과 애초에 쓴 적이 없는 것은 다른 사실이다.
  // AGENT_RUN_STATUS_ORDER(agent-run-status.ts) 7종 중 더 안 늘어남이 확실한 셋만 terminal —
  // running/queued/held/hitl_pending은 재개·진행 여지가 있어 "아직"이 맞는 사실이다.
  const isTerminal = runStatus === 'completed' || runStatus === 'failed' || runStatus === 'abandoned';
  const hasMore = totalCount != null ? rows.length < totalCount : rows.length === LIMIT && rows.length > 0;

  return (
    <SectionCard>
      <SectionCardHeader>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          {t('toolCallsTitle')}
          {totalCount != null && <CountBadge count={totalCount} />}
        </h2>
      </SectionCardHeader>
      <SectionCardBody>
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />)}
          </div>
        ) : loadError ? (
          <p className="text-sm text-muted-foreground">{t('toolCallsLoadError')}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {isTerminal ? t('toolCallsEmptyNone') : t('toolCallsEmptyPending')}
          </p>
        ) : (
          <>
            <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {rows.map((row) => (
                <ToolCallRowItem
                  key={row.id}
                  row={row}
                  locale={locale}
                  displayTimezone={displayTimezone}
                  expanded={expandedId === row.id}
                  onToggleExpand={() => setExpandedId((id) => (id === row.id ? null : row.id))}
                  t={t}
                />
              ))}
            </div>
            {hasMore && (
              <div className="mt-3 flex justify-center">
                <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? t('toolCallsLoadingMore') : t('loadMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}

function ToolCallRowItem({
  row,
  locale,
  displayTimezone,
  expanded,
  onToggleExpand,
  t,
}: {
  row: ToolCallRow;
  locale: string;
  displayTimezone: string;
  expanded: boolean;
  onToggleExpand: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const success = isSuccessStatus(row.status_code);
  // story #3722(유나 판정 축①·페드루 PO 지적 #4089 리뷰 2026-09-09) — method/path/
  // duration_ms는 운영 지표에 가깝다: tool 이름이 있으면 그게 1차, method+path+duration은
  // 부제로 демoted. tool이 없을 때(REST 직접 호출·구버전 클라이언트) 처음엔 method+path를
  // 1차로 승격했었으나(D2/D3 "정직한 최후 수단"을 잘못 적용) — 그건 **모름을 정직히 쓰는
  // 것이 아니라 코드 값(HTTP 경로)이 제목 자리에 서는 같은 클래스**였다(오늘 이벤트 키·
  // stibee와 같은 결함). 「이름 없는 호출」(모름을 모름이라 쓴다 — 지어낸 이름 아님)로
  // 고정하고, 경로는 tool 유무와 무관하게 항상 부제로만(행 형을 하나로 통일).
  const hasDetail = row.input_summary != null || !!row.error;
  const primaryLabel = row.tool ?? t('toolCallsUnnamedCall');
  return (
    <div className="p-3" data-testid={`tool-call-row-${row.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {hasDetail ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onToggleExpand}
                className="gap-1 truncate p-0 px-1 font-mono text-sm font-normal text-foreground"
                data-testid={`tool-call-toggle-${row.id}`}
              >
                {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                {primaryLabel}
              </Button>
            ) : (
              <span className="truncate font-mono text-sm text-foreground" data-testid={`tool-call-primary-${row.id}`}>
                {primaryLabel}
              </span>
            )}
            <Badge variant={success ? 'success' : 'destructive'}>
              {success ? t('toolCallsSuccessBadge') : t('toolCallsFailedBadge')}
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{toLocaleStr(row.started_at, locale, displayTimezone)}</span>
            <span>·</span>
            <span>{formatDuration(row.duration_ms)}</span>
            <span className="truncate font-mono">{row.method} {row.path}</span>
          </div>
        </div>
      </div>
      {expanded && hasDetail && (
        <div className="mt-2 space-y-2 rounded-md border border-white/8 bg-white/4 p-3">
          {row.input_summary != null && (
            <div>
              <p className="text-xs font-medium text-foreground">{t('toolCallsInputSummaryLabel')}</p>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                {JSON.stringify(row.input_summary, null, 2)}
              </pre>
            </div>
          )}
          {row.error && (
            // 페드루 PO 지적(2026-09-09, PR2 사전 스티어) — `error: str | None`(BE 원문 —
            // 예외 메시지·트레이스백 조각일 수 있다)을 raw로 바로 안 올린다. 사람이 읽는
            // 한 줄(고정 문구)은 항상 보이고, 원문은 접기(ConnectionRow의
            // channelLastErrorToggle과 동형 <details>/<summary> 관례).
            <div>
              <p className="text-xs font-medium text-destructive">{t('toolCallsErrorSummary')}</p>
              <details className="mt-1 text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t('toolCallsErrorToggle')}</summary>
                <p className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px]">{row.error}</p>
              </details>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
