'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRight, Plus } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/db/client';

interface OrgAgent {
  id: string;
  name: string;
  role: string;
  is_active: boolean;
  // story #2751(설계②) — BE `_inject_active_stories()`가 배치 주입(fan-out 없음, PO
  // 확定 — get_verified_map()). false=stdio verify 미완주(이탈 후보) — "연결 안 됨" CTA
  // 대상. undefined/null이면 판별 불가(예: 이 필드를 아직 안 실어보내는 옛 응답 형태
  // 방어) — 그 경우 CTA를 안 띄운다(거짓 "연결 안 됨" 낙인 방지, 침묵 실패보다 과소표시가
  // 안전한 방향).
  verified?: boolean | null;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface AccessRecord {
  member_id?: string | null;
}

interface AgentManagementTabProps {
  /** story d82c1092(생성경로 단일화) — "에이전트 추가"는 채용 탭으로 라우팅한다(별도 모달 제거). */
  onAddAgent?: () => void;
}

/**
 * story #2406 AC1 — 되돌릴 수 없는 방향(비활성화)에만 확認을 붙이고, 되돌릴 수 있는 방향
 * (활성화)엔 안 붙인다(PO 설계 판단 ②: 양쪽에 붙이면 무게가 같아져 되돌릴 수 없는 쪽의 경고가
 * 묽어진다). 실사고(2026-08-01) — 확認 없이 즉시 실행되어 PO 자신의 계정이 잘못 눌려 비활성화됐다.
 */
export function requiresDeactivateConfirm(agent: Pick<OrgAgent, 'is_active'>): boolean {
  return agent.is_active;
}

/**
 * story d63d3f73 §5② — org 에이전트 목록(관리 탭). 접근 프로젝트 수 요약은 에이전트별
 * fan-out(A×P) 대신 프로젝트별 access 를 P 콜로 한 번만 조회해 member_id 기준으로 집계한다
 * (AgentProjectAccessSection 의 단일-에이전트 fan-out과 동일 원천, org 목록에 맞게 방향만 반전 —
 * Phase 2 매트릭스가 우려하는 N×M 콜과 다름: 프로젝트 수 P에만 비례, 에이전트 수와는 무관).
 */
export function AgentManagementTab({ onAddAgent }: AgentManagementTabProps) {
  const t = useTranslations('settings');
  const ta = useTranslations('agents');
  const tc = useTranslations('common');
  const [agents, setAgents] = useState<OrgAgent[]>([]);
  const [grantCounts, setGrantCounts] = useState<Record<string, number>>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  // story #1989: mount effect가 try/catch 없이 fetch를 직결해 네트워크 실패(오프라인 등) 시
  // fetch가 throw → setLoading(false)가 영영 안 불려 스켈레톤이 무한 행("loading은 finally에서
  // 해소" 하우스룰 위반). loadError로 실패를 별도 상태화해 재시도 affordance를 노출한다.
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<OrgAgent | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // settings/page.tsx 컨벤션과 동일: plain(비-useCallback) 헬퍼 — mount effect가 이를 호출하는
  // 체인 안에서 setState가 일어나도 react-hooks/set-state-in-effect가 useCallback 체인만큼
  // 깊이 추적하지 않는다(AgentPerformancePanel·AgentProjectAccessSection은 위임 없이 자체
  // setState라 통과, 여기선 refreshAgents/refreshGrantCounts로 위임하므로 plain fn 유지).
  const refreshAgents = async () => {
    const res = await fetchWithAuth('/api/team-members?type=agent&include_inactive=true');
    if (!res.ok) return;
    const json = await res.json() as { data?: OrgAgent[] };
    setAgents(json.data ?? []);
  };

  const refreshGrantCounts = async (projectList: ProjectOption[]) => {
    if (projectList.length === 0) { setGrantCounts({}); return; }
    const results = await Promise.all(
      projectList.map((p) =>
        fetchWithAuth(`/api/projects/${p.id}/access`)
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
      setLoadError(false);
      try {
        // story #3519(§16-7 2부, PO 確定 2026-09-05) — 둘 다 부수(ok?채움:방치, 예를 들어
        // meRes는 isAdmin 판정만 바꾼다)인데 격리가 없어, meRes가 네트워크단 reject하면
        // 이 try/catch 바깥 catch가 setLoadError(true)로 «승격»시켜 에이전트 목록(이
        // 탭의 실제 주 콘텐츠, refreshAgents가 따로 그린다)까지 통째로 못 뜨게 했다.
        const [meRes, projectsRes] = await Promise.all([
          fetchWithAuth('/api/me').catch(() => null),
          fetchWithAuth('/api/projects').catch(() => null),
        ]);
        if (meRes?.ok) {
          const meJson = await meRes.json() as { data?: { role?: string } };
          const role = meJson.data?.role ?? 'member';
          setIsAdmin(role === 'admin' || role === 'owner');
        }
        let projectList: ProjectOption[] = [];
        if (projectsRes?.ok) {
          const json = await projectsRes.json() as { data?: ProjectOption[] };
          projectList = (json.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
        }
        await Promise.all([refreshAgents(), refreshGrantCounts(projectList)]);
      } catch {
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [retryKey]);

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
      // story #2485 — backend update_team_member()는 generic HTTP상태 코드만 낸다
      // (진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 대신 고정 문구.
      setMessage({ type: 'error', text: t('agentActionFailed') });
    }
    setTogglingId(null);
  };

  // story #2406 AC1 — 되돌릴 수 없는 방향(비활성화)만 확認 다이얼로그로 가로챈다.
  // 활성화는 되돌릴 수 있는 조작이라 즉시 실행(설계 판단 ②, PO 확認).
  const requestToggle = (agent: OrgAgent) => {
    if (requiresDeactivateConfirm(agent)) {
      setDeactivateTarget(agent);
      return;
    }
    void handleToggleActive(agent);
  };

  const confirmDeactivate = async () => {
    if (!deactivateTarget) return;
    const target = deactivateTarget;
    setDeactivateTarget(null);
    await handleToggleActive(target);
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
              <Button variant="hero" size="sm" className="shrink-0 gap-1.5" onClick={onAddAgent}>
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
          ) : loadError ? (
            <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border px-3 py-8 text-center">
              <p className="text-sm text-muted-foreground">{tc('error')}</p>
              <p className="text-xs text-muted-foreground">{tc('errorDescription')}</p>
              <Button size="sm" variant="outline" onClick={() => setRetryKey((k) => k + 1)}>
                {tc('retry')}
              </Button>
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
                  <Link href={`/organization/workforce/${agent.id}`} className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground hover:underline hover:text-primary">{agent.name}</span>
                      {!agent.is_active ? <Badge variant="destructive">inactive</Badge> : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{t('agentMember')}</Badge>
                      <Badge variant="outline">{agent.role}</Badge>
                      <Badge variant="info">{ta('manageProjectsGranted', { count: grantCounts[agent.id] ?? 0 })}</Badge>
                      {agent.verified === false ? (
                        <Badge variant="warning">{ta('agentNotConnected')}</Badge>
                      ) : null}
                    </div>
                  </Link>
                  <div className="flex shrink-0 items-center gap-2">
                    {agent.verified === false ? (
                      <Link
                        href={`/organization/workforce/${agent.id}`}
                        className="whitespace-nowrap text-xs font-medium text-primary hover:underline"
                      >
                        {ta('viewConnectionSettings')}
                      </Link>
                    ) : null}
                    {isAdmin ? (
                      <Button
                        variant="glass"
                        size="sm"
                        onClick={() => requestToggle(agent)}
                        disabled={togglingId === agent.id}
                      >
                        {togglingId === agent.id ? '...' : agent.is_active ? t('deactivateAgent') : t('activateAgent')}
                      </Button>
                    ) : null}
                    <Link href={`/organization/workforce/${agent.id}`} className="text-muted-foreground hover:text-foreground">
                      <ChevronRight className="size-4" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCardBody>
      </SectionCard>

      <Dialog open={!!deactivateTarget} onOpenChange={(o) => { if (!o) setDeactivateTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            {/* story #2406 AC1 — 대상 이름은 «제목»에(본문에 두면 안 읽힌다). 실사고: 확認 없이
                즉시 실행되어 목록 최상단 행(다른 사람)이 잘못 눌려 비활성화됐다. */}
            <DialogTitle>
              {deactivateTarget ? t('deactivateAgentDialogTitle', { name: deactivateTarget.name }) : ''}
            </DialogTitle>
            <DialogDescription>{t('deactivateAgentDialogBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeactivateTarget(null)} disabled={togglingId === deactivateTarget?.id}>
              {tc('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDeactivate()}
              disabled={togglingId === deactivateTarget?.id}
            >
              {togglingId === deactivateTarget?.id ? '...' : t('deactivateAgentDialogConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
