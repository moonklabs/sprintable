'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Shield, ShieldOff, Loader2 } from 'lucide-react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { ListRow } from '@/components/ds/list-row';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { DetailCard } from '@/components/agents/detail-card';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * org-agent 멀티프로젝트 접근 관리 (story 088987d8).
 *
 * 휴먼용 ProjectAccessSection("한 프로젝트 × 멤버 토글")을 **에이전트-중심으로 반전**한다 —
 * "한 에이전트 × org 전체 프로젝트, 각 행에 허용/차단 grant 토글". add/remove 를 토글 하나로 통합.
 * 단일 키 grant 모델: grant/revoke 가 API 키에 영향 없음(키 1개 유지). 신규 토큰 0.
 *
 * grant 식별자 = 에이전트의 member id(= team_member.id = anchor members.id; org_agent 가 grant 시
 * member_id=member.id 로 fan-out 한 그 값). 에이전트-중심 조회 엔드포인트가 없어 org 전체 프로젝트를
 * 순회(`GET .../access`)하며 member_id 일치 grant 맵(project_id→record_id)을 구성한다(v1 fan-out).
 */

interface ProjectOption {
  id: string;
  name: string;
}

interface AccessRecord {
  id: string;
  member_id?: string | null;
}

interface AgentProjectAccessSectionProps {
  agentMemberId: string;
  projects: ProjectOption[];
  canEdit: boolean;
}

export function AgentProjectAccessSection({ agentMemberId, projects, canEdit }: AgentProjectAccessSectionProps) {
  const t = useTranslations('settings');
  // project_id → grant record_id (granted 프로젝트만 키 보유).
  const [grantMap, setGrantMap] = useState<Record<string, string>>({});
  // GET access 가 403 인 프로젝트(read 권한 없음) — "grant 없음(차단)"과 구분(RC③). 잘못된 '차단' 표시 방지.
  const [readDeniedIds, setReadDeniedIds] = useState<Set<string>>(new Set());
  // 일시 오류(500/네트워크 등 non-403)로 상태 미확정인 프로젝트 — "grant 없음"으로 단정하지 않고 재시도 노출.
  const [errorIds, setErrorIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const projectsKey = projects.map((p) => p.id).join(',');

  const loadGrants = useCallback(async () => {
    setLoading(true);
    // v1 fan-out: org 전체 프로젝트 access 조회 → member_id===agent 필터로 grant 맵 구성.
    // 403(read 권한 없음)·일시 오류(500/네트워크)는 각각 별도 추적 — "grant 없음(차단)"으로
    // 오해석해 잘못된 토글/POST 를 유발하지 않는다(RC③·일시오류 fall-through RC).
    const results = await Promise.all(projects.map(async (p) => {
      const res = await fetchWithAuth(`/api/projects/${p.id}/access`).catch(() => null);
      if (res?.status === 403) return { projectId: p.id, readDenied: true } as const;
      if (!res?.ok) return { projectId: p.id, error: true } as const; // transient — granted/denied 단정 안 함
      const json = await res.json() as { data?: AccessRecord[] };
      const rec = (json.data ?? []).find((r) => r.member_id === agentMemberId);
      return { projectId: p.id, recordId: rec?.id } as const;
    }));
    const map: Record<string, string> = {};
    const denied = new Set<string>();
    const errored = new Set<string>();
    for (const r of results) {
      if ('readDenied' in r) denied.add(r.projectId);
      else if ('error' in r) errored.add(r.projectId);
      else if (r.recordId) map[r.projectId] = r.recordId;
    }
    setGrantMap(map);
    setReadDeniedIds(denied);
    setErrorIds(errored);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentMemberId, projectsKey]);

  useEffect(() => { void loadGrants(); }, [loadGrants]);

  const handleToggle = async (projectId: string) => {
    if (!canEdit || togglingId) return;
    setTogglingId(projectId);
    setMessage(null);
    const recordId = grantMap[projectId];
    const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;
    try {
      if (recordId) {
        // 차단 — DELETE grant (키 불변).
        const res = await fetchWithAuth(`/api/projects/${projectId}/access/${recordId}`, { method: 'DELETE' });
        if (res.ok) {
          setGrantMap((m) => { const n = { ...m }; delete n[projectId]; return n; });
          setMessage({ type: 'success', text: t('agentProjectAccessTakeOff', { project: projectName }) });
        } else {
          setMessage({ type: 'error', text: t('agentProjectAccessTakeOffFailed', { project: projectName }) });
        }
      } else {
        // 허용 — POST grant (새 API 키 발급 없음).
        const res = await fetchWithAuth(`/api/projects/${projectId}/access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_id: agentMemberId, org_member_id: null, permission: 'granted' }),
        });
        if (res.ok) {
          let recId = (await res.json().catch(() => null) as { data?: AccessRecord } | null)?.data?.id;
          if (!recId) {
            // 응답에 record id 없으면 해당 프로젝트만 재조회(1콜)로 확보.
            const g = await fetchWithAuth(`/api/projects/${projectId}/access`).catch(() => null);
            if (g?.ok) {
              const j = await g.json() as { data?: AccessRecord[] };
              recId = (j.data ?? []).find((r) => r.member_id === agentMemberId)?.id;
            }
          }
          if (recId) setGrantMap((m) => ({ ...m, [projectId]: recId! }));
          setMessage({ type: 'success', text: t('agentProjectAccessPutOn', { project: projectName }) });
        } else {
          setMessage({ type: 'error', text: t('agentProjectAccessPutOnFailed', { project: projectName }) });
        }
      }
    } finally {
      setTogglingId(null);
    }
  };

  const grantedCount = Object.keys(grantMap).length;

  return (
    <DetailCard
      data-testid="agent-detail-card-project-access"
      title={t('agentProjectAccessTitle')}
      description={t('agentProjectAccessDesc')}
      action={!loading && projects.length > 0 ? (
        <div className="shrink-0 text-right text-ds-small tabular-nums text-ds-ink-3">
          <div className="font-medium text-ds-ink">{grantedCount} / {projects.length}</div>
          <div>{t('projectAccessGrantedLabel')}</div>
        </div>
      ) : undefined}
    >
        {message && (
          // story #2105 2차 — handleToggle이 재시도 전 setMessage(null)을 먼저 호출해(위 정의) 매
          // 시도마다 언마운트→리마운트된다. 에러=alert/assertive, 성공=status/polite.
          // story 4912 (C2c): the ds Banner carries the role (failed = alert · info = status) — role=alert already means assertive + atomic, role=status polite + atomic. A second aria-live on an inner element made the same text a nested live region (read twice); there is ONE live region now (PO + codex).
          <Banner tone={message.type === 'success' ? 'info' : 'failed'} className="rounded-ds-control">
            {message.text}
          </Banner>
        )}

        {loading ? (
          <SkeletonGroup label={t('agentProjectAccessTitle')} className="space-y-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}
          </SkeletonGroup>
        ) : projects.length === 0 ? (
          <p className="rounded-ds-control border border-dashed border-ds-line px-3 py-6 text-ds-body text-ds-ink-3">
            {t('noAccessibleProjects')}
          </p>
        ) : (
          <div className="focus-inset max-h-72 overflow-y-auto overflow-x-hidden rounded-ds-control border border-ds-line [&>*:last-child]:border-b-0">
            {projects.map((project) => {
              const errored = errorIds.has(project.id);
              const readDenied = readDeniedIds.has(project.id);
              const granted = project.id in grantMap;
              const toggling = togglingId === project.id;
              return (
                <ListRow
                  key={project.id}
                  density="compact"
                  title={project.name}
                  trailing={errored ? (
                    // story 4912 (C2c, codex round 2): role=alert on the <button> itself displaced its button role; the alert is the wrapper (announced at once, atomic) and the button keeps being a button
                    <span role="alert" aria-atomic="true" className="inline-flex">
                      <Button variant="quiet" onClick={() => void loadGrants()} className="text-ds-failed">
                        {t('loadFailedRetry')}
                      </Button>
                    </span>
                  ) : readDenied ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-ds-small text-ds-ink-3" title={t('readAccessDeniedTooltip')}>
                      {t('readAccessDenied')}
                    </span>
                  ) : canEdit ? (
                    <Button
                      variant="secondary"
                      disabled={toggling}
                      onClick={() => void handleToggle(project.id)}
                      className={cn(
                        'min-w-[72px] shrink-0 gap-1',
                        // story 4912 (C2c): allowed = the «done» tint with ink text (never a coloured text on a tint); blocked = neutral
                        granted ? 'border-ds-done bg-ds-done-soft text-ds-ink hover:bg-ds-done-soft' : 'text-ds-ink-3',
                      )}
                    >
                      {toggling ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : granted ? (
                        <><Shield className="h-3 w-3" />{t('projectAccessAllowed')}</>
                      ) : (
                        <><ShieldOff className="h-3 w-3" />{t('projectAccessBlocked')}</>
                      )}
                    </Button>
                  ) : (
                    <span className={cn(
                      'inline-flex shrink-0 items-center gap-1 text-ds-small',
                      granted ? 'text-ds-done' : 'text-ds-ink-3',
                    )}>
                      {granted ? <Shield className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
                      {granted ? t('projectAccessAllowed') : t('projectAccessBlocked')}
                    </span>
                  )}
                />
              );
            })}
          </div>
        )}
    </DetailCard>
  );
}
