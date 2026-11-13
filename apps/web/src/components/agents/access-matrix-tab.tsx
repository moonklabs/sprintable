'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { PageFrame } from '@/components/ds/page-frame';
import { PageHead } from '@/components/ds/page-head';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { DetailCard } from '@/components/agents/detail-card';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/db/client';
import { isSystemPublisher } from '@/lib/runtime-capabilities';
import { memberRowLabels } from '@/lib/member-display';

interface OrgAgent {
  id: string;
  name: string;
  // story #3997 CHANGES(카디르 「고르는 자리」 전수, 페드루 확定 2026-09-17) — 「시스템
  // 발행」 행 자체를 매트릭스에서 제외하는 데 쓴다(예약 멤버의 프로젝트 접근을 회수하면
  // 자동 발행이 막힐 수 있어, 토글이 아니라 행 제외 — 서버 측 원자적 거부는 story #3999).
  runtime_type?: string | null;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface AccessMatrixRow {
  agent_member_id: string;
  project_id: string;
  record_id: string;
}

export type AccessMatrixMessageState = { type: 'success' | 'error'; text: string } | null;

// story #2153: 선언(type: 'success'|'error')과 렌더가 갈라져 있던 결함 — success가 들어와도 항상 destructive/alert였다. 렌더 분기를 별도 컴포넌트로 빼 두 경우를 직접 테스트한다.
// story 4912 (D): the ds Banner carries the role (failed = alert · info = status) — the ONE live region (no aria-live on top of it).
export function AccessMatrixMessage({ message }: { message: AccessMatrixMessageState }) {
  if (!message) return null;
  return <Banner tone={message.type === 'success' ? 'info' : 'failed'}>{message.text}</Banner>;
}

/**
 * story da4c6b2d — org 전체 에이전트(행) × 프로젝트(열) 접근권한 매트릭스.
 * 데이터 = `agent-project-access-section.tsx`(상세 per-agent 토글)와 동일 원천
 * (`project_access`)의 다른 pivot. bulk 시드는 `GET /api/agents/access-matrix`(PR #1948,
 * org 단위 단일 쿼리 — Phase 1 관리탭 요약과 달리 admin/owner 게이트가 전체 매트릭스 단위라
 * 개별 셀 403은 발생하지 않는다. 일시 오류(네트워크/500)만 매트릭스 전체 재시도로 처리).
 * grant/revoke 쓰기는 기존 v1 엔드포인트 그대로 재사용 — 신규 API 없음.
 */
export function AccessMatrixTab() {
  const t = useTranslations('settings');
  const ta = useTranslations('agents');

  const [agents, setAgents] = useState<OrgAgent[]>([]);
  // story #4311 — 같은 이름 구성원이 한 목록에서 갈리게 행 라벨은 memberRowLabels(member-display 한 곳의 꼬리 규칙)로.
  const tc = useTranslations('common');
  const rowLabels = useMemo(() => memberRowLabels(agents, tc, () => ''), [agents, tc]);

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  // (agent_member_id, project_id) → record_id. 없으면 차단.
  const [grantMap, setGrantMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<AccessMatrixMessageState>(null);

  const key = (agentId: string, projectId: string) => `${agentId}::${projectId}`;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      // story #2952 AC2 — 이 매트릭스는 관리(비활성화/재활성) 화면이 아니라 grant 조회/편집
      // 화면이라, deactivate된 에이전트는 관리탭(AgentManagementTab)의 "활성화" 경로로만
      // 다시 마주친다. include_inactive=true였을 때 비활성 에이전트 행이 grant 0개인 채
      // 그대로 남아 "창구 불일치"(deactivate가 화면에서 안 지워짐)의 절반이었다.
      const [agentsRes, projectsRes, matrixRes] = await Promise.all([
        fetchWithAuth('/api/team-members?type=agent'),
        fetchWithAuth('/api/projects'),
        fetchWithAuth('/api/agents/access-matrix'),
      ]);
      if (!agentsRes.ok || !projectsRes.ok || !matrixRes.ok) { setLoadError(true); return; }
      const agentsJson = await agentsRes.json() as { data?: OrgAgent[] };
      const projectsJson = await projectsRes.json() as { data?: ProjectOption[] };
      const matrixJson = await matrixRes.json() as { data?: AccessMatrixRow[] };

      setAgents((agentsJson.data ?? []).filter((a) => !isSystemPublisher(a.runtime_type)));
      setProjects((projectsJson.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)));

      const map: Record<string, string> = {};
      for (const row of matrixJson.data ?? []) {
        map[key(row.agent_member_id, row.project_id)] = row.record_id;
      }
      setGrantMap(map);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleToggle = async (agentId: string, project: ProjectOption) => {
    const k = key(agentId, project.id);
    if (togglingKey) return;
    setTogglingKey(k);
    setMessage(null);
    const recordId = grantMap[k];
    try {
      if (recordId) {
        const res = await fetch(`/api/projects/${project.id}/access/${recordId}`, { method: 'DELETE' });
        if (res.ok) {
          setGrantMap((m) => { const n = { ...m }; delete n[k]; return n; });
        } else {
          setMessage({ type: 'error', text: t('agentActionFailed') });
        }
      } else {
        const res = await fetch(`/api/projects/${project.id}/access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_id: agentId, org_member_id: null, permission: 'granted' }),
        });
        if (res.ok) {
          let recId = (await res.json().catch(() => null) as { data?: { id?: string } } | null)?.data?.id;
          if (!recId) {
            const g = await fetchWithAuth(`/api/agents/access-matrix`).catch(() => null);
            if (g?.ok) {
              const j = await g.json() as { data?: AccessMatrixRow[] };
              recId = (j.data ?? []).find((r) => r.agent_member_id === agentId && r.project_id === project.id)?.record_id;
            }
          }
          if (recId) setGrantMap((m) => ({ ...m, [k]: recId! }));
        } else {
          setMessage({ type: 'error', text: t('agentActionFailed') });
        }
      }
    } catch {
      // story 4912 (PO 11-13): a REJECTED request (the network went away) said nothing — the cell just came back. It is the same failure as an HTTP error answer, so it says the same sentence.
      setMessage({ type: 'error', text: t('agentActionFailed') });
    } finally {
      setTogglingKey(null);
    }
  };

  const grantedCount = Object.keys(grantMap).length;
  const totalCells = agents.length * projects.length;

  const head = <PageHead description={ta('matrixDescription')} meta={ta('matrixAdminOnlyHint')} />;

  if (loading) {
    return (
      <PageFrame width="wide">
        {head}
        <SkeletonGroup label={tc('loading')} className="space-y-2" data-testid="access-matrix-loading">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}
        </SkeletonGroup>
      </PageFrame>
    );
  }

  if (loadError) {
    return (
      <PageFrame width="wide">
        {head}
        <div data-testid="access-matrix-load-error">
          <Banner tone="failed" action={<Button variant="secondary" onClick={() => void load()}>{ta('matrixRetry')}</Button>}>
            {ta('matrixLoadError')}
          </Banner>
        </div>
      </PageFrame>
    );
  }

  return (
    <PageFrame width="wide">
      {head}
      <DetailCard
        data-testid="access-matrix-card"
        title={ta('matrixTitle')}
        action={totalCells > 0 ? (
          <div className="shrink-0 text-right text-ds-small tabular-nums text-ds-ink-3">
            <div className="font-medium text-ds-ink">{grantedCount} / {totalCells}</div>
            <div>{ta('matrixGrantedCount')}</div>
          </div>
        ) : null}
      >
        <AccessMatrixMessage message={message} />

        {agents.length === 0 || projects.length === 0 ? (
          <p className="rounded-ds-control border border-dashed border-ds-line px-3 py-8 text-center text-ds-small text-ds-ink-3">{ta('matrixEmpty')}</p>
        ) : (
          // story #2165: 표는 전역 스크롤바 숨김 예외 — 가로로 잘린 열이 있다는 것을 알려야 한다.
          <div className="focus-inset scrollbar-visible overflow-x-auto rounded-ds-control bg-ds-surface-sunk">
            <table className="w-full border-collapse text-ds-body">
              <thead>
                <tr className="bg-ds-surface-high">
                  <th className="sticky left-0 z-10 bg-ds-surface-high px-3 py-2 text-left font-medium text-ds-ink">
                    {ta('matrixAgentColumn')}
                  </th>
                  {projects.map((project) => (
                    <th key={project.id} className="whitespace-nowrap px-3 py-2 text-left font-medium text-ds-ink">
                      {project.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ds-line">
                {agents.map((agent) => (
                  <tr key={agent.id}>
                    <td className="sticky left-0 z-10 bg-ds-surface-sunk px-3 py-2 font-medium text-ds-ink">
                      {rowLabels.get(agent.id)}
                    </td>
                    {projects.map((project) => {
                      const k = key(agent.id, project.id);
                      const granted = k in grantMap;
                      const toggling = togglingKey === k;
                      return (
                        <td key={project.id} className="px-3 py-2 text-center">
                          <Button
                            variant="secondary"
                            loading={toggling}
                            onClick={() => void handleToggle(agent.id, project)}
                            className={cn('w-8 px-0', granted && 'border-ds-done bg-ds-done-soft text-ds-done hover:bg-ds-done-soft')}
                            aria-label={granted ? ta('matrixCellGranted') : ta('matrixCellBlocked')}
                            aria-pressed={granted}
                            data-granted={granted ? '' : undefined}
                          >
                            {granted && !toggling ? <Icon name="check" size={14} /> : null}
                          </Button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4 text-ds-small text-ds-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex size-4 items-center justify-center rounded-ds-tag border border-ds-done bg-ds-done-soft text-ds-done">
              <Icon name="check" size={10} />
            </span>
            {ta('matrixLegendGranted')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-4 rounded-ds-tag border border-ds-line-control" />
            {ta('matrixLegendBlocked')}
          </span>
        </div>
      </DetailCard>
    </PageFrame>
  );
}
