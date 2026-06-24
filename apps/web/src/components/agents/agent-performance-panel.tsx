'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, TrendingUp, Trophy, Zap, Clock, CheckCircle } from 'lucide-react';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Badge } from '@/components/ui/badge';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

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

function VelocityChart({ items }: { items: SprintVelocityItem[] }) {
  const recent = items.slice(-5);
  const maxV = Math.max(...recent.map((s) => s.velocity ?? 0), 1);

  return (
    <div className="space-y-2">
      {recent.map((sprint) => {
        const v = sprint.velocity ?? 0;
        const pct = Math.round((v / maxV) * 100);
        return (
          <div key={sprint.id} className="flex items-center gap-3">
            <span className="w-28 shrink-0 truncate text-xs text-muted-foreground" title={sprint.title}>
              {sprint.title}
            </span>
            <div className="flex-1 overflow-hidden rounded-full bg-muted/50 h-2">
              <div
                className="h-2 rounded-full bg-primary transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-right text-xs font-medium text-foreground">{v}</span>
          </div>
        );
      })}
      {recent.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">스프린트 데이터가 없습니다.</p>
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

export function AgentPerformancePanel() {
  const t = useTranslations('agentPerformance');
  const { projectId } = useDashboardContext();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [velocity, setVelocity] = useState<SprintVelocityItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [membersRes, velocityRes, lbRes] = await Promise.all([
        fetch(`/api/team-members?project_id=${projectId}&type=agent`),
        fetch(`/api/analytics/velocity-history?project_id=${projectId}`),
        fetch(`/api/rewards/leaderboard?project_id=${projectId}&period=all`),
      ]);

      const membersJson = membersRes.ok ? (await membersRes.json() as { data: AgentMember[] | null }) : null;
      const velocityJson = velocityRes.ok ? (await velocityRes.json() as { data: SprintVelocityItem[] | null }) : null;
      const lbJson = lbRes.ok ? (await lbRes.json() as { data: LeaderboardEntry[] | null }) : null;

      const agentMembers = (membersJson?.data ?? []).filter((m) => m.type === 'agent');
      const leaderboard: LeaderboardEntry[] = lbJson?.data ?? [];
      const balanceMap: Record<string, number> = {};
      leaderboard.forEach((e, i) => { balanceMap[e.member_id] = e.balance ?? 0; void i; });

      const sorted = [...leaderboard].sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
      const rankMap: Record<string, number> = {};
      sorted.forEach((e, i) => { rankMap[e.member_id] = i + 1; });

      const statsResults = await Promise.allSettled(
        agentMembers.map((m) =>
          fetch(`/api/analytics/agent-stats?project_id=${projectId}&agent_id=${m.id}`)
            .then(async (r) => {
              if (!r.ok) return null;
              const j = await r.json() as { data: AgentStats | null };
              return j.data;
            })
            .catch(() => null),
        ),
      );

      setAgents(
        agentMembers.map((m, i) => ({
          ...m,
          stats: statsResults[i]?.status === 'fulfilled' ? (statsResults[i] as PromiseFulfilledResult<AgentStats | null>).value : null,
          rank: rankMap[m.id] ?? null,
          balance: balanceMap[m.id] ?? 0,
        })),
      );
      setVelocity(velocityJson?.data ?? []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
        <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
          {t('loading')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-5xl space-y-6">

        {/* Agent stat cards */}
        <SectionCard>
          <SectionCardHeader>
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-primary" />
              <span className="text-sm font-semibold text-foreground">{t('agentStatsTitle')}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('agentStatsDescription')}</p>
          </SectionCardHeader>
          <SectionCardBody>
            {agents.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('noAgents')}</p>
            ) : (
              // 목업 ① de-boxy dense grid: per-card 테두리 제거·gap-px divider·중첩 메트릭 박스→flex 행(아이콘이 타입)
              <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl bg-border sm:grid-cols-2 lg:grid-cols-3">
                {agents.map((agent) => (
                  <div key={agent.id} className="space-y-2 bg-background p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-foreground">{agent.name}</div>
                        {agent.rank != null && (
                          <div className="mt-0.5 flex items-center gap-1">
                            <Trophy className="size-3 text-warning" />
                            <span className="text-xs text-muted-foreground">#{agent.rank}</span>
                          </div>
                        )}
                      </div>
                      <Badge variant="chip" className="shrink-0 text-xs">
                        {agent.balance} TJSB
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-4 text-xs">
                      <span className="inline-flex items-center gap-1 text-success" title={t('doneStories')}>
                        <CheckCircle className="size-3.5" />
                        <span className="font-semibold tabular-nums">{agent.stats?.completed ?? 0}</span>
                      </span>
                      <span className="inline-flex items-center gap-1 text-primary" title={t('assignedStories')}>
                        <Zap className="size-3.5" />
                        <span className="font-semibold tabular-nums">{agent.stats?.total_stories ?? 0}</span>
                      </span>
                      <span className="inline-flex items-center gap-1 text-muted-foreground" title={t('avgLeadTime')}>
                        <Clock className="size-3.5" />
                        <span className="font-semibold tabular-nums">{formatDuration(agent.stats?.avg_lead_time_ms ?? 0)}</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCardBody>
        </SectionCard>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Velocity chart */}
          <SectionCard>
            <SectionCardHeader>
              <div className="flex items-center gap-2">
                <TrendingUp className="size-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">{t('velocityTitle')}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('velocityDescription')}</p>
            </SectionCardHeader>
            <SectionCardBody>
              <VelocityChart items={velocity} />
            </SectionCardBody>
          </SectionCard>

          {/* Leaderboard */}
          <SectionCard>
            <SectionCardHeader>
              <div className="flex items-center gap-2">
                <Trophy className="size-4 text-warning" />
                <span className="text-sm font-semibold text-foreground">{t('leaderboardTitle')}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('leaderboardDescription')}</p>
            </SectionCardHeader>
            <SectionCardBody className="divide-y divide-border/60">
              {agents.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">{t('noAgents')}</p>
              ) : (
                [...agents]
                  .sort((a, b) => b.balance - a.balance)
                  .map((agent, idx) => (
                    <div
                      key={agent.id}
                      className="flex items-center gap-3 px-3 py-2.5"
                    >
                      <span className={`w-6 shrink-0 text-center text-sm font-bold ${idx === 0 ? 'text-warning' : idx === 1 ? 'text-muted-foreground' : idx === 2 ? 'text-warning/70' : 'text-muted-foreground'}`}>
                        {idx + 1}
                      </span>
                      <span className="flex-1 truncate text-sm font-medium text-foreground">{agent.name}</span>
                      <Badge variant={idx === 0 ? 'success' : 'chip'} className="shrink-0 text-xs">
                        {agent.balance} TJSB
                      </Badge>
                    </div>
                  ))
              )}
            </SectionCardBody>
          </SectionCard>
        </div>

      </div>
    </div>
  );
}
