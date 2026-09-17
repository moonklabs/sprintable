'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/db/client';
import {
  ConnectRulesV3SectionEmpty,
  ConnectRulesV3SectionError,
  ConnectRulesV3SectionSkeleton,
} from './connect-rules-v3-section-state';

/**
 * story #3982 §(c) 연결된 에이전트 — `GET /api/team-members?type=agent`(agent-management-
 * tab.tsx와 같은 콜) 1콜. 행 펼침은 project_id가 있는 행만 agent-stats를 추가로(project_id
 * 필수 파라미터라 org 전체 집계는 없다, #3980 그라운딩 확認 그대로) 지연 조회하고,
 * access-matrix(org admin/owner 전용, 403 가능)는 펼침과 무관하게 org 1콜만 미리 받아
 * 클라에서 필터한다(N+1 금지).
 */
interface OrgAgent {
  id: string;
  name: string;
  role: string;
  is_active: boolean;
  verified?: boolean | null;
  presence_status?: 'online' | 'idle' | 'offline' | null;
  project_id?: string | null;
}

interface AgentStats {
  completed: number;
  total_stories: number;
  done_story_points: number;
  avg_lead_time_ms: number;
}

interface AccessMatrixRow {
  agent_member_id: string;
  project_id: string;
  record_id: string;
}

// story #3982 — trust-utils.tsx::DEFAULT_ROLE_LABEL_KEY와 같은 축(team_member.role은
// 사람에겐 member/admin/owner 권한값이지만, 에이전트 행에선 SoD 워크플로 역할값
// implementation/po/qa/design/devops로 쓰인다, agent-management-tab.tsx가 이미 같은
// 필드로 resolveRoleLabel을 부르는 선례) — 이 화면은 유나 낱말표 D절 패턴("{역할} 담당
// 에이전트")을 그 축 위에 적용한 전용 라벨(짧은 trustRoleLabel*과 다른 문구, 새 필드 0).
const ROLE_LABEL_KEY: Record<string, string> = {
  implementation: 'roleLabelImplementation',
  design: 'roleLabelDesign',
  qa: 'roleLabelQa',
  po: 'roleLabelPo',
  devops: 'roleLabelDevops',
};

function formatLeadTimeDays(avgLeadTimeMs: number): number {
  return Math.round(avgLeadTimeMs / (24 * 60 * 60 * 1000));
}

export function ConnectRulesV3Agents() {
  const t = useTranslations('connectRulesV3');
  const ta = useTranslations('agents');
  const [agents, setAgents] = useState<OrgAgent[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [accessMatrix, setAccessMatrix] = useState<AccessMatrixRow[] | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [retryKey, setRetryKey] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statsByAgent, setStatsByAgent] = useState<Record<string, AgentStats | null>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadState('loading');
      try {
        const [agentsRes, meRes] = await Promise.all([
          fetchWithAuth('/api/team-members?type=agent'),
          fetchWithAuth('/api/me'),
        ]);
        if (!agentsRes.ok) {
          if (!cancelled) setLoadState('error');
          return;
        }
        const agentsJson = await agentsRes.json() as { data?: OrgAgent[] };
        if (cancelled) return;
        setAgents(agentsJson.data ?? []);

        let admin = false;
        if (meRes.ok) {
          const meJson = await meRes.json() as { data?: { role?: string } };
          admin = meJson.data?.role === 'admin' || meJson.data?.role === 'owner';
        }
        if (cancelled) return;
        setIsAdmin(admin);

        if (admin) {
          const matrixRes = await fetchWithAuth('/api/agents/access-matrix').catch(() => null);
          if (!cancelled && matrixRes?.ok) {
            const matrixJson = await matrixRes.json() as { data?: AccessMatrixRow[] };
            setAccessMatrix(matrixJson.data ?? []);
          }
        }
        if (!cancelled) setLoadState('ready');
      } catch {
        if (!cancelled) setLoadState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [retryKey]);

  const toggleExpand = useCallback((agent: OrgAgent) => {
    setExpandedId((prev) => (prev === agent.id ? null : agent.id));
    if (agent.project_id && !(agent.id in statsByAgent)) {
      void fetchWithAuth(`/api/analytics/agent-stats?project_id=${agent.project_id}&agent_id=${agent.id}`)
        .then((res) => (res.ok ? res.json() as Promise<{ data?: AgentStats }> : null))
        .then((json) => setStatsByAgent((prev) => ({ ...prev, [agent.id]: json?.data ?? null })))
        .catch(() => setStatsByAgent((prev) => ({ ...prev, [agent.id]: null })));
    }
  }, [statsByAgent]);

  if (loadState === 'loading') return <ConnectRulesV3SectionSkeleton />;
  if (loadState === 'error') return <ConnectRulesV3SectionError onRetry={() => setRetryKey((k) => k + 1)} />;

  return (
    <div className="space-y-2">
      {agents.length === 0 ? (
        <ConnectRulesV3SectionEmpty title={t('agentsEmptyTitle')} />
      ) : (
        agents.map((agent) => {
          const expanded = expandedId === agent.id;
          const grantCount = accessMatrix?.filter((r) => r.agent_member_id === agent.id).length;
          const stats = statsByAgent[agent.id];
          const roleKey = Object.hasOwn(ROLE_LABEL_KEY, agent.role) ? ROLE_LABEL_KEY[agent.role] : undefined;
          const presenceLabel = agent.presence_status === 'online'
            ? t('presenceOnline')
            : agent.presence_status === 'idle'
              ? t('presenceIdle')
              : t('presenceOffline');

          return (
            <div key={agent.id} className="rounded-md border border-border bg-muted/30 text-sm" data-testid="connect-rules-v3-agent-row">
              <button
                type="button"
                onClick={() => toggleExpand(agent)}
                aria-expanded={expanded}
                className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate font-medium text-foreground">{agent.name}</span>
                    <span className="text-xs text-muted-foreground">{roleKey ? t(roleKey) : agent.role}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{presenceLabel}</p>
                </div>
                {agent.verified === false ? (
                  <Badge variant="warning">{ta('agentNotConnected')}</Badge>
                ) : (
                  <Badge variant="secondary">{t('agentConnected')}</Badge>
                )}
              </button>

              {expanded ? (
                <div className="space-y-2 border-t border-border px-3 py-3 text-xs text-muted-foreground" data-testid="connect-rules-v3-agent-row-expanded">
                  {agent.verified === false ? (
                    <Link href={`/organization/workforce/${agent.id}`} className="font-medium text-primary hover:underline">
                      {ta('viewConnectionSettings')}
                    </Link>
                  ) : null}
                  {agent.project_id ? (
                    stats ? (
                      <p>
                        {t('agentStatsCompleted', { count: stats.completed })}
                        {' · '}
                        {t('agentStatsLeadTime', { days: formatLeadTimeDays(stats.avg_lead_time_ms) })}
                      </p>
                    ) : null
                  ) : null}
                  {isAdmin ? (
                    grantCount !== undefined ? (
                      <p>{t('agentAccessGranted', { count: grantCount })}</p>
                    ) : null
                  ) : (
                    <p>{t('agentAccessUnavailable')}</p>
                  )}
                </div>
              ) : null}
            </div>
          );
        })
      )}
      <Link
        href="/organization/workforce/recruiter"
        className="inline-block text-xs font-medium text-primary hover:underline"
        data-testid="connect-rules-v3-add-agent-link"
      >
        {ta('manageAddAgent')}
      </Link>
    </div>
  );
}
