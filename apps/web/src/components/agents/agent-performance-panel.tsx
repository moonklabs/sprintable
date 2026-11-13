'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { Metric } from '@/components/ds/metric';
import { PageFrame } from '@/components/ds/page-frame';
import { PageHead } from '@/components/ds/page-head';
import { ProgressBar } from '@/components/ds/progress-bar';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { DetailCard } from '@/components/agents/detail-card';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

import { fetchWithAuth } from '@/lib/db/client';
import { memberRowLabels } from '@/lib/member-display';
import { RowName } from '@/components/shared/row-name';

interface AgentMember {
  id: string;
  name: string;
  type: string;
}

interface AgentStats {
  completed: number;
  total_stories: number;
  done_story_points: number;
  avg_lead_time_ms: number;
}

interface SprintVelocityItem {
  id: string;
  title: string;
  velocity: number | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
}

interface LeaderboardEntry {
  member_id: string;
  balance: number;
}

interface AgentRow extends AgentMember {
  stats: AgentStats | null;
  rank: number | null;
  balance: number;
}

/** one read of the three the page makes: «failed» (an error answer, a rejected request or an unreadable body) is NOT the same as «answered with nothing» */
type Read<T> = { ok: true; data: T | null } | { ok: false };

/**
 * The three reads answer LISTS. An array is the list; «nothing» is an empty list — `null` / a missing `data` and the proxy's `{ ok: true }` marker (the leaderboard route turns a 204 into `{ data: { ok: true } }`);
 * anything else (a string, a number, another object) cannot be read as a list → «failed» (codex round 1: such a shape used to throw inside the shaping and land in the catch as a members failure).
 */
function asList<T>(data: unknown, markerIsEmpty: boolean): T[] | null {
  if (Array.isArray(data)) return data as T[];
  if (data === null || data === undefined) return [];
  // the `{ ok: true }` marker is the LEADERBOARD route's 204 only (codex round 2) — a members / velocity read never has it, so there it is a malformed answer
  if (markerIsEmpty && typeof data === 'object' && (data as { ok?: unknown }).ok === true) return [];
  return null;
}

async function readList<T>(request: Promise<Response>, markerIsEmpty = false): Promise<Read<T[]>> {
  try {
    const res = await request;
    if (!res.ok) return { ok: false };
    const list = asList<T>(((await res.json()) as { data?: unknown }).data, markerIsEmpty);
    return list === null ? { ok: false } : { ok: true, data: list };
  } catch {
    return { ok: false };
  }
}

function VelocityChart({ items }: { items: SprintVelocityItem[] }) {
  const t = useTranslations('agentPerformance');
  const recent = items.slice(-5);
  const maxV = Math.max(...recent.map((s) => s.velocity ?? 0), 1);

  return (
    <div className="space-y-3">
      {recent.map((sprint) => {
        const v = sprint.velocity ?? 0;
        return (
          <div key={sprint.id} className="flex items-center gap-3">
            <span className="w-28 shrink-0 truncate text-ds-small text-ds-ink-3" title={sprint.title}>
              {sprint.title}
            </span>
            <ProgressBar className="min-w-0 flex-1" aria-label={sprint.title} value={v} max={maxV} tone="usage" valueText={String(v)} />
          </div>
        );
      })}
      {recent.length === 0 && (
        <p className="py-2 text-center text-ds-small text-ds-ink-3">{t('noSprintData')}</p>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/**
 * story 4912 (D) — the statistics tab on the ds parts, `wide` (a table-like grid): PageHead (the scope chip «이 프로젝트» is its meta line — it was a bar above the panel) + one Card per section
 * (DetailCard: title + description in its header), the numbers = `Metric`, the velocity bars = `ProgressBar`, a rank/balance = `Chip`. Same data, same three reads, same wording.
 * A FAILED read is never shown as «none» (before: a rejected/failed members read said «배포된 에이전트가 없어요», a failed velocity / leaderboard read said «스프린트 데이터가 없어요» / listed nobody): any failed
 * read raises ONE failure Banner with [다시 시도], and the part that depended on it says «못 읽었어요» (a number = «—» + a readable reason) instead of an empty answer.
 */
export function AgentPerformancePanel() {
  const t = useTranslations('agentPerformance');
  const ta = useTranslations('agents');
  const tc = useTranslations('common');
  const { projectId } = useDashboardContext();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  // story #4311 — 같은 이름 구성원이 한 목록에서 갈리게 행 라벨은 memberRowLabels(member-display 한 곳의 꼬리 규칙)로.
  const rowLabels = useMemo(() => memberRowLabels(agents, tc, () => ''), [agents, tc]);

  const [velocity, setVelocity] = useState<SprintVelocityItem[]>([]);
  const [loading, setLoading] = useState(true);
  // story #4185(유나 design) — 묶음 호출 자체가 실패하면 전원이 «0»으로 보여 «실적 없음»과 갈리지 않았다.
  // 실패면 숫자 칸은 «—», 섹션에 안내 한 줄+다시 시도. 묶음은 성공인데 일부 키만 빠지면 그 에이전트만 빈 지표(안내 없음).
  const [statsLoadFailed, setStatsLoadFailed] = useState(false);
  const [membersFailed, setMembersFailed] = useState(false);
  const [velocityFailed, setVelocityFailed] = useState(false);
  const [leaderboardFailed, setLeaderboardFailed] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [members, velocityRead, leaderboardRead] = await Promise.all([
        readList<AgentMember>(fetchWithAuth(`/api/team-members?project_id=${projectId}&type=agent`)),
        readList<SprintVelocityItem>(fetchWithAuth(`/api/analytics/velocity-history?project_id=${projectId}`)),
        readList<LeaderboardEntry>(fetchWithAuth(`/api/rewards/leaderboard?project_id=${projectId}&period=all`), true),
      ]);

      const agentMembers = (members.ok ? members.data ?? [] : []).filter((m) => m.type === 'agent');
      const leaderboard: LeaderboardEntry[] = leaderboardRead.ok ? leaderboardRead.data ?? [] : [];
      const balanceMap: Record<string, number> = {};
      leaderboard.forEach((e) => { balanceMap[e.member_id] = e.balance ?? 0; });

      const sorted = [...leaderboard].sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
      const rankMap: Record<string, number> = {};
      sorted.forEach((e, i) => { rankMap[e.member_id] = i + 1; });

      // story #4185 — 에이전트마다 단건을 따로 부르던 N+1(prod 한 화면 5회+·각 0.5초)을 묶음 1회로.
      // 실패·누락은 그 에이전트만 null(예전 단건 실패와 같은 표시).
      let statsById: Record<string, AgentStats> = {};
      let failed = false;
      if (agentMembers.length > 0) {
        const ids = agentMembers.map((m) => m.id).join(',');
        const batch = await fetchWithAuth(`/api/analytics/agent-stats/batch?project_id=${projectId}&agent_ids=${ids}`)
          .then(async (r) => (r.ok ? ((await r.json()) as { data: Record<string, AgentStats> | null }).data ?? {} : null))
          .catch(() => null);
        failed = batch === null;
        statsById = batch ?? {};
      }
      setStatsLoadFailed(failed);
      setMembersFailed(!members.ok);
      setVelocityFailed(!velocityRead.ok);
      setLeaderboardFailed(!leaderboardRead.ok);

      setAgents(
        agentMembers.map((m) => ({
          ...m,
          stats: statsById[m.id] ?? null,
          rank: rankMap[m.id] ?? null,
          balance: balanceMap[m.id] ?? 0,
        })),
      );
      setVelocity(velocityRead.ok ? velocityRead.data ?? [] : []);
    } catch {
      // the three reads cannot reject (readList answers «failed»); only an unexpected throw in the shaping lands here — it is a failure too, never an empty screen
      setMembersFailed(true);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const anyFailed = membersFailed || statsLoadFailed || velocityFailed || leaderboardFailed;
  const scopeChip = <Chip tone="info">{ta('scopeThisProject')}</Chip>;

  if (loading) {
    return (
      <PageFrame width="wide">
        <PageHead description={t('agentStatsDescription')} meta={scopeChip} />
        <SkeletonGroup label={t('loading')} className="space-y-3" data-testid="agent-stats-loading">
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </SkeletonGroup>
      </PageFrame>
    );
  }

  return (
    <PageFrame width="wide">
      <PageHead description={t('agentStatsDescription')} meta={scopeChip} />

      {anyFailed ? (
        <div data-testid="agent-stats-load-error">
          <Banner tone="failed" action={<Button variant="secondary" onClick={() => void load()}>{tc('retry')}</Button>}>
            {t('agentStatsLoadError')}
          </Banner>
        </div>
      ) : null}

      {/* Agent stats — one card, one row per agent (it was a hand-built 3-column grid of boxes) */}
      {membersFailed ? null : (
        <DetailCard data-testid="agent-stats-card" title={t('agentStatsTitle')} description={t('agentStatsDescription')}>
          {agents.length === 0 ? (
            <p className="py-2 text-center text-ds-small text-ds-ink-3">{t('noAgents')}</p>
          ) : (
            <ul className="m-0 list-none divide-y divide-ds-line p-0">
              {agents.map((agent) => (
                <li key={agent.id} className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:items-center" data-testid={`agent-stats-row-${agent.id}`}>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <RowName className="text-ds-body font-semibold text-ds-ink" label={rowLabels.get(agent.id)} id={agent.id} />
                    {!leaderboardFailed && agent.rank != null ? <Chip>#{agent.rank}</Chip> : null}
                    {!leaderboardFailed ? <Chip>{agent.balance} TJSB</Chip> : null}
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <Metric
                      icon="check_circle"
                      iconTone="done"
                      label={t('doneStories')}
                      {...(statsLoadFailed ? { unavailable: true as const, unavailableLabel: t('agentStatsLoadError') } : { value: agent.stats?.completed ?? 0 })}
                    />
                    <Metric
                      icon="bolt"
                      label={t('assignedStories')}
                      {...(statsLoadFailed ? { unavailable: true as const, unavailableLabel: t('agentStatsLoadError') } : { value: agent.stats?.total_stories ?? 0 })}
                    />
                    <Metric
                      icon="schedule"
                      label={t('avgLeadTime')}
                      {...(statsLoadFailed ? { unavailable: true as const, unavailableLabel: t('agentStatsLoadError') } : { value: formatDuration(agent.stats?.avg_lead_time_ms ?? 0) })}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DetailCard>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Velocity chart */}
        <DetailCard data-testid="agent-velocity-card" title={t('velocityTitle')} description={t('velocityDescription')}>
          {velocityFailed ? (
            <p className="py-2 text-center text-ds-small text-ds-ink-3" data-testid="agent-velocity-load-failed">{t('velocityLoadFailed')}</p>
          ) : (
            <VelocityChart items={velocity} />
          )}
        </DetailCard>

        {/* Leaderboard */}
        {membersFailed ? null : (
          <DetailCard data-testid="agent-leaderboard-card" title={t('leaderboardTitle')} description={t('leaderboardDescription')}>
            {leaderboardFailed ? (
              <p className="py-2 text-center text-ds-small text-ds-ink-3" data-testid="agent-leaderboard-load-failed">{t('leaderboardLoadFailed')}</p>
            ) : agents.length === 0 ? (
              <p className="py-2 text-center text-ds-small text-ds-ink-3">{t('noAgents')}</p>
            ) : (
              <ol className="m-0 list-none divide-y divide-ds-line p-0">
                {[...agents]
                  .sort((a, b) => b.balance - a.balance)
                  .map((agent, idx) => (
                    <li key={agent.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                      <span className="w-6 shrink-0 text-center font-mono text-ds-body font-semibold tabular-nums text-ds-ink-2">{idx + 1}</span>
                      <RowName className="flex-1 text-ds-body font-medium text-ds-ink" label={rowLabels.get(agent.id)} id={agent.id} />
                      <Chip className="shrink-0">{agent.balance} TJSB</Chip>
                    </li>
                  ))}
              </ol>
            )}
          </DetailCard>
        )}
      </div>
    </PageFrame>
  );
}
