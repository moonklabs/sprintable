'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRight, Plus } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { AddAgentDialog } from '@/components/agents/add-agent-dialog';

interface OrgAgent {
  id: string;
  name: string;
  role: string;
  is_active: boolean;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface AccessRecord {
  member_id?: string | null;
}

/**
 * story d63d3f73 §5② — org 에이전트 목록(관리 탭). 접근 프로젝트 수 요약은 에이전트별
 * fan-out(A×P) 대신 프로젝트별 access 를 P 콜로 한 번만 조회해 member_id 기준으로 집계한다
 * (AgentProjectAccessSection 의 단일-에이전트 fan-out과 동일 원천, org 목록에 맞게 방향만 반전 —
 * Phase 2 매트릭스가 우려하는 N×M 콜과 다름: 프로젝트 수 P에만 비례, 에이전트 수와는 무관).
 */
export function AgentManagementTab() {
  const t = useTranslations('settings');
  const ta = useTranslations('agents');
  const [agents, setAgents] = useState<OrgAgent[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [grantCounts, setGrantCounts] = useState<Record<string, number>>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // settings/page.tsx 컨벤션과 동일: plain(비-useCallback) 헬퍼 — mount effect가 이를 호출하는
  // 체인 안에서 setState가 일어나도 react-hooks/set-state-in-effect가 useCallback 체인만큼
  // 깊이 추적하지 않는다(AgentPerformancePanel·AgentProjectAccessSection은 위임 없이 자체
  // setState라 통과, 여기선 refreshAgents/refreshGrantCounts로 위임하므로 plain fn 유지).
  const refreshAgents = async () => {
    const res = await fetch('/api/team-members?type=agent&include_inactive=true');
    if (!res.ok) return;
    const json = await res.json() as { data?: OrgAgent[] };
    setAgents(json.data ?? []);
  };

  const refreshGrantCounts = async (projectList: ProjectOption[]) => {
    if (projectList.length === 0) { setGrantCounts({}); return; }
    const results = await Promise.all(
      projectList.map((p) =>
        fetch(`/api/projects/${p.id}/access`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null) as Promise<{ data?: AccessRecord[] } | null>,
      ),
    );
    const counts: Record<string, number> = {};
    for (const json of results) {
      for (const rec of json?.data ?? []) {
        if (!rec.member_id) continue;
        counts[rec.member_id] = (counts[rec.member_id] ?? 0) + 1;
      }
    }
    setGrantCounts(counts);
  };

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const [meRes, projectsRes] = await Promise.all([
        fetch('/api/me'),
        fetch('/api/projects'),
      ]);
      if (meRes.ok) {
        const meJson = await meRes.json() as { data?: { role?: string } };
        const role = meJson.data?.role ?? 'member';
        setIsAdmin(role === 'admin' || role === 'owner');
      }
      let projectList: ProjectOption[] = [];
      if (projectsRes.ok) {
        const json = await projectsRes.json() as { data?: ProjectOption[] };
        projectList = (json.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
        setProjects(projectList);
      }
      await Promise.all([refreshAgents(), refreshGrantCounts(projectList)]);
      setLoading(false);
    })();
  }, []);

  const handleToggleActive = async (agent: OrgAgent) => {
    setTogglingId(agent.id);
    setMessage(null);
    const res = await fetch(`/api/team-members/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !agent.is_active }),
    });
    if (res.ok) {
      setMessage({ type: 'success', text: agent.is_active ? t('agentDeactivated') : t('agentActivated') });
      await refreshAgents();
    } else {
      const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setMessage({ type: 'error', text: json?.error?.message ?? t('agentActionFailed') });
    }
    setTogglingId(null);
  };

  return (
    <div className="p-6">
      <SectionCard>
        <SectionCardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">{t('orgAgentsTitle')}</h2>
              <p className="text-sm text-muted-foreground">{t('orgAgentsDescription')}</p>
            </div>
            {isAdmin ? (
              <Button variant="hero" size="sm" className="shrink-0 gap-1.5" onClick={() => setAddOpen(true)}>
                <Plus className="size-3.5" /> {ta('manageAddAgent')}
              </Button>
            ) : null}
          </div>
        </SectionCardHeader>
        <SectionCardBody className="space-y-4">
          {message ? (
            <Alert variant={message.type === 'success' ? 'success' : 'destructive'}>
              <AlertDescription>{message.text}</AlertDescription>
            </Alert>
          ) : null}

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <div key={i} className="h-14 animate-pulse rounded-md bg-muted" />)}
            </div>
          ) : agents.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-8 text-center">
              <p className="text-sm text-muted-foreground">{t('noOrgAgents')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('noOrgAgentsCta')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {agents.map((agent) => (
                <div key={agent.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-3 text-sm">
                  <Link href={`/agents/${agent.id}`} className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground hover:underline hover:text-primary">{agent.name}</span>
                      {!agent.is_active ? <Badge variant="destructive">inactive</Badge> : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{t('agentMember')}</Badge>
                      <Badge variant="outline">{agent.role}</Badge>
                      <Badge variant="info">{ta('manageProjectsGranted', { count: grantCounts[agent.id] ?? 0 })}</Badge>
                    </div>
                  </Link>
                  <div className="flex shrink-0 items-center gap-2">
                    {isAdmin ? (
                      <Button
                        variant="glass"
                        size="sm"
                        onClick={() => void handleToggleActive(agent)}
                        disabled={togglingId === agent.id}
                      >
                        {togglingId === agent.id ? '...' : agent.is_active ? t('deactivateAgent') : t('activateAgent')}
                      </Button>
                    ) : null}
                    <Link href={`/agents/${agent.id}`} className="text-muted-foreground hover:text-foreground">
                      <ChevronRight className="size-4" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCardBody>
      </SectionCard>

      <AddAgentDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        projects={projects}
        onCreated={() => { void refreshAgents(); void refreshGrantCounts(projects); }}
      />
    </div>
  );
}
