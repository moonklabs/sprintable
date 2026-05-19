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
  total_runs: number;
  completed: number;
  failed: number;
  total_tokens: number;
  total_cost_usd: number;
  avg_duration_ms: number;
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
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {agents.map((agent) => (
                  <div key={agent.id} className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-foreground">{agent.name}</div>
                        {agent.rank != null && (
                          <div className="flex items-center gap-1 mt-0.5">
                            <Trophy className="size-3 text-amber-400" />
                            <span className="text-xs text-muted-foreground">#{agent.rank}</span>
                          </div>
                        )}
                      </div>
                      <Badge variant="chip" className="shrink-0 text-xs">
                        {agent.balance} TJSB
                      </Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-md bg-muted/50 px-2 py-2">
                        <div className="flex items-center justify-center gap-1 text-emerald-500">
                          <CheckCircle className="size-3" />
                          <span className="text-base font-bold">{agent.stats?.completed ?? 0}</span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">{t('completed')}</div>
                      </div>
                      <div className="rounded-md bg-muted/50 px-2 py-2">
                        <div className="flex items-center justify-center gap-1 text-primary">
                          <Zap className="size-3" />
                          <span className="text-base font-bold">{agent.stats?.total_runs ?? 0}</span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">{t('totalRuns')}</div>
                      </div>
                      <div className="rounded-md bg-muted/50 px-2 py-2">
                        <div className="flex items-center justify-center gap-1 text-muted-foreground">
                          <Clock className="size-3" />
                          <span className="text-base font-bold">{formatDuration(agent.stats?.avg_duration_ms ?? 0)}</span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">{t('avgDuration')}</div>
                      </div>
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
                <Trophy className="size-4 text-amber-400" />
                <span className="text-sm font-semibold text-foreground">{t('leaderboardTitle')}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('leaderboardDescription')}</p>
            </SectionCardHeader>
            <SectionCardBody className="space-y-2">
              {agents.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">{t('noAgents')}</p>
              ) : (
                [...agents]
                  .sort((a, b) => b.balance - a.balance)
                  .map((agent, idx) => (
                    <div
                      key={agent.id}
                      className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5"
                    >
                      <span className={`w-6 shrink-0 text-center text-sm font-bold ${idx === 0 ? 'text-amber-400' : idx === 1 ? 'text-slate-400' : idx === 2 ? 'text-amber-600' : 'text-muted-foreground'}`}>
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
