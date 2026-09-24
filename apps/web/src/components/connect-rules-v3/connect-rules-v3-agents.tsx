'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchWithAuth } from '@/lib/db/client';
import { isSystemPublisher, runtimeLabel } from '@/lib/runtime-capabilities';
import {
  ConnectRulesV3SectionEmpty,
  ConnectRulesV3SectionError,
  ConnectRulesV3SectionSkeleton,
} from './connect-rules-v3-section-state';
import { useFlatHref } from '@/hooks/use-flat-href';

/**
 * story #3982 §(c) 연결된 에이전트 — `GET /api/team-members?type=agent` 1콜만 마운트
 * 시 부른다. `agent_role`+`runtime_type` 조합 표시(PO CHANGES-4).
 *
 * PO CHANGES-r3-1(2026-09-17, PASS 재오픈·카디르 콜 카운트 지적) — 첫 화면 콜이
 * 비관리자 8·관리자 9로 AC2(≤6) 초과 판명. 처방: ① `role`을 화면(이미 `/api/me`를
 * 부른다)에서 prop으로 받아 이 절의 중복 `/api/me` 콜 제거 ② `/api/projects`(프로젝트
 * 이름)·`/api/agents/access-matrix`(admin/owner 전용)는 마운트 즉시가 아니라 **첫 행
 * 펼침 때 1회만** 지연 로드하고 그 뒤엔 캐시(재펼침마다 재조회 0) — 둘 다 펼친 행에만
 * 쓰는 데이터라 마운트 예산에 넣을 이유가 없었다. 결과: 마운트 콜 = team-members
 * 1개뿐(화면 예산엔 이미 안 잡힘), 첫 펼침 때만 +1(projects)/+2(관리자, +access-matrix).
 *
 * PO CHANGES-4(2026-09-17, dev 실측: moonklabs 에이전트 11 전원 role="member"·
 * agent_role=null) — team_member.role은 실제로 SoD 워크플로 라벨(implementation/
 * design/qa/po/devops)로 안 쓰인다(가정이 틀렸었다). 지어낸 roleLabel* 5키를
 * 삭제하고 `agent_role`이 있을 때만 그 값을 그대로 보여준다(번역 0 — 값 자체가
 * 자유 문자열이라 지어낼 수 없다) + `runtime_type`을 「· {runtime}」로 덧붙인다
 * (시안 「디자인 담당 에이전트 · Claude Code」의 뒷부분, team_member.py:82 확認 필드).
 *
 * PO CHANGES-r2-1(2026-09-17) — `runtime_type` raw 키(`claude-code`·`codex`·
 * `system-publisher`)를 그대로 찍으면 안 된다. `runtime-capabilities.ts::
 * runtimeLabel()`(registry 조회, 등록키만 표시명·미등재/null이면 null — 원값
 * 「보존」을 명시적으로 폐기한 story #3103 규율)을 그대로 재사용 — 새 라벨 매핑을
 * 이 파일에 다시 짓지 않는다.
 */
interface OrgAgent {
  id: string;
  name: string;
  agent_role?: string | null;
  runtime_type?: string | null;
  is_active: boolean;
  verified?: boolean | null;
  presence_status?: 'online' | 'idle' | 'offline' | null;
  project_id?: string | null;
}

interface ProjectOption {
  id: string;
  name: string;
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

function formatLeadTimeDays(avgLeadTimeMs: number): number {
  return Math.round(avgLeadTimeMs / (24 * 60 * 60 * 1000));
}

export function ConnectRulesV3Agents({ isAdmin }: { isAdmin: boolean }) {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('connectRulesV3');
  const ta = useTranslations('agents');
  const [agents, setAgents] = useState<OrgAgent[]>([]);
  const [projectsById, setProjectsById] = useState<Record<string, string> | null>(null);
  const [accessMatrix, setAccessMatrix] = useState<AccessMatrixRow[] | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [retryKey, setRetryKey] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statsByAgent, setStatsByAgent] = useState<Record<string, AgentStats | null | 'error'>>({});
  const [statsLoadingId, setStatsLoadingId] = useState<string | null>(null);
  // story #3982 PO CHANGES-r3-1 — projects·access-matrix는 첫 펼침에 1회만(중복 fetch
  // 방어는 projectsById!==null/accessMatrix!==null 체크만으론 "요청 진행 中" 구간을 못
  // 잡는다 — 연타 펼침 레이스 방지용 별도 ref-less 플래그).
  const [expandDataLoading, setExpandDataLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadState('loading');
      try {
        const agentsRes = await fetchWithAuth('/api/team-members?type=agent');
        if (!agentsRes.ok) {
          if (!cancelled) setLoadState('error');
          return;
        }
        const agentsJson = await agentsRes.json() as { data?: OrgAgent[] };
        if (cancelled) return;
        setAgents(agentsJson.data ?? []);
        setLoadState('ready');
      } catch {
        if (!cancelled) setLoadState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [retryKey]);

  const toggleExpand = useCallback((agent: OrgAgent) => {
    setExpandedId((prev) => (prev === agent.id ? null : agent.id));

    if (projectsById === null && !expandDataLoading) {
      setExpandDataLoading(true);
      void Promise.all([
        fetchWithAuth('/api/projects').then((res) => (res.ok ? res.json() as Promise<{ data?: ProjectOption[] }> : null)),
        isAdmin ? fetchWithAuth('/api/agents/access-matrix').catch(() => null) : Promise.resolve(null),
      ]).then(async ([projectsJson, matrixRes]) => {
        setProjectsById(Object.fromEntries((projectsJson?.data ?? []).map((p) => [p.id, p.name])));
        if (matrixRes?.ok) {
          const matrixJson = await matrixRes.json() as { data?: AccessMatrixRow[] };
          setAccessMatrix(matrixJson.data ?? []);
        }
      }).finally(() => setExpandDataLoading(false));
    }

    if (agent.project_id && !(agent.id in statsByAgent)) {
      setStatsLoadingId(agent.id);
      void fetchWithAuth(`/api/analytics/agent-stats?project_id=${agent.project_id}&agent_id=${agent.id}`)
        .then((res) => (res.ok ? res.json() as Promise<{ data?: AgentStats }> : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((json) => setStatsByAgent((prev) => ({ ...prev, [agent.id]: json.data ?? 'error' })))
        .catch(() => setStatsByAgent((prev) => ({ ...prev, [agent.id]: 'error' }))
        )
        .finally(() => setStatsLoadingId((prev) => (prev === agent.id ? null : prev)));
    }
  }, [statsByAgent, projectsById, expandDataLoading, isAdmin]);

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
          const statsLoading = statsLoadingId === agent.id;
          const roleLine = [agent.agent_role, runtimeLabel(agent.runtime_type)].filter(Boolean).join(' · ');
          const presenceLabel = agent.presence_status === 'online'
            ? t('presenceOnline')
            : agent.presence_status === 'idle'
              ? t('presenceIdle')
              : t('presenceOffline');
          const projectName = agent.project_id ? projectsById?.[agent.project_id] : undefined;

          return (
            <div key={agent.id} className="rounded-md border border-border bg-muted/30 text-sm" data-testid="connect-rules-v3-agent-row">
              <Button
                type="button"
                variant="ghost"
                onClick={() => toggleExpand(agent)}
                aria-expanded={expanded}
                className="h-auto w-full items-center justify-between gap-3 rounded-md px-3 py-3 text-left font-normal"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate font-medium text-foreground">{agent.name}</span>
                    {roleLine ? <span className="text-xs text-muted-foreground">{roleLine}</span> : null}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{presenceLabel}</p>
                </div>
                {isSystemPublisher(agent.runtime_type) ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{ta('systemPublisherNeutralDescription')}</span>
                ) : agent.verified === false ? (
                  <Badge variant="warning">{ta('agentNotConnected')}</Badge>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">{t('agentConnected')}</span>
                )}
              </Button>

              {expanded ? (
                <div className="space-y-2 border-t border-border px-3 py-3 text-xs text-muted-foreground" data-testid="connect-rules-v3-agent-row-expanded">
                  {/* story #3994 AC3 — 이 행엔 연결 설정 CTA도 없다(연결 대상 자체가
                      아니다, PO 판정). */}
                  {!isSystemPublisher(agent.runtime_type) ? (
                    <Link href={flatHref(`/organization/workforce/${agent.id}`)} className="font-medium text-primary hover:underline">
                      {ta('viewConnectionSettings')}
                    </Link>
                  ) : null}
                  {agent.project_id ? (
                    statsLoading ? (
                      <Skeleton className="h-4 w-40" />
                    ) : stats === 'error' ? (
                      <p className="text-destructive">{t('loadErrorTitle')}</p>
                    ) : stats ? (
                      <p>
                        {t('agentStatsCompleted', { count: stats.completed })}
                        {' · '}
                        {t('agentStatsLeadTime', { days: formatLeadTimeDays(stats.avg_lead_time_ms) })}
                        {projectName ? ` · ${t('agentStatsProjectScope', { project: projectName })}` : ''}
                      </p>
                    ) : null
                  ) : null}
                  {isAdmin && grantCount !== undefined ? (
                    <p>{t('agentAccessGranted', { count: grantCount })}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      )}
      <Link
        href={flatHref('/organization/workforce/recruiter')}
        className="inline-block text-xs font-medium text-primary hover:underline"
        data-testid="connect-rules-v3-add-agent-link"
      >
        {ta('manageAddAgent')}
      </Link>
    </div>
  );
}
