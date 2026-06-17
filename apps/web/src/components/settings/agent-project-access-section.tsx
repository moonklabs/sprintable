'use client';

import { useEffect, useState } from 'react';
import { Shield, ShieldOff, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';

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
  // project_id → grant record_id (granted 프로젝트만 키 보유).
  const [grantMap, setGrantMap] = useState<Record<string, string>>({});
  // GET access 가 403 인 프로젝트(read 권한 없음) — "grant 없음(차단)"과 구분(RC③). 잘못된 '차단' 표시 방지.
  const [readDeniedIds, setReadDeniedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const projectsKey = projects.map((p) => p.id).join(',');

  useEffect(() => {
    let cancelled = false;
    async function loadGrants() {
      setLoading(true);
      // v1 fan-out: org 전체 프로젝트 access 조회 → member_id===agent 필터로 grant 맵 구성.
      // 403(read 권한 없음)은 별도 추적해 "grant 없음(차단)"으로 오해석하지 않는다(RC③).
      const results = await Promise.all(projects.map(async (p) => {
        const res = await fetch(`/api/projects/${p.id}/access`).catch(() => null);
        if (res?.status === 403) return { projectId: p.id, readDenied: true } as const;
        if (!res?.ok) return { projectId: p.id } as const; // 일시 오류 — granted/denied 단정 안 함
        const json = await res.json() as { data?: AccessRecord[] };
        const rec = (json.data ?? []).find((r) => r.member_id === agentMemberId);
        return { projectId: p.id, recordId: rec?.id } as const;
      }));
      if (cancelled) return;
      const map: Record<string, string> = {};
      const denied = new Set<string>();
      for (const r of results) {
        if ('readDenied' in r && r.readDenied) denied.add(r.projectId);
        else if ('recordId' in r && r.recordId) map[r.projectId] = r.recordId;
      }
      setGrantMap(map);
      setReadDeniedIds(denied);
      setLoading(false);
    }
    void loadGrants();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentMemberId, projectsKey]);

  const handleToggle = async (projectId: string) => {
    if (!canEdit || togglingId) return;
    setTogglingId(projectId);
    setMessage(null);
    const recordId = grantMap[projectId];
    const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;
    try {
      if (recordId) {
        // 차단 — DELETE grant (키 불변).
        const res = await fetch(`/api/projects/${projectId}/access/${recordId}`, { method: 'DELETE' });
        if (res.ok) {
          setGrantMap((m) => { const n = { ...m }; delete n[projectId]; return n; });
          setMessage({ type: 'success', text: `${projectName} 접근을 차단했습니다.` });
        } else {
          setMessage({ type: 'error', text: `${projectName} 차단에 실패했습니다.` });
        }
      } else {
        // 허용 — POST grant (새 API 키 발급 없음).
        const res = await fetch(`/api/projects/${projectId}/access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_id: agentMemberId, org_member_id: null, permission: 'granted' }),
        });
        if (res.ok) {
          let recId = (await res.json().catch(() => null) as { data?: AccessRecord } | null)?.data?.id;
          if (!recId) {
            // 응답에 record id 없으면 해당 프로젝트만 재조회(1콜)로 확보.
            const g = await fetch(`/api/projects/${projectId}/access`).catch(() => null);
            if (g?.ok) {
              const j = await g.json() as { data?: AccessRecord[] };
              recId = (j.data ?? []).find((r) => r.member_id === agentMemberId)?.id;
            }
          }
          if (recId) setGrantMap((m) => ({ ...m, [projectId]: recId! }));
          setMessage({ type: 'success', text: `${projectName} 접근을 허용했습니다.` });
        } else {
          setMessage({ type: 'error', text: `${projectName} 허용에 실패했습니다.` });
        }
      }
    } finally {
      setTogglingId(null);
    }
  };

  const grantedCount = Object.keys(grantMap).length;

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">프로젝트 접근</h2>
            <p className="text-sm text-muted-foreground">
              이 에이전트는 API 키 1개로 아래 프로젝트들에 접근합니다. 프로젝트를 추가/제거해도 키는 그대로 유지됩니다.
            </p>
          </div>
          {!loading && projects.length > 0 ? (
            <div className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              <div className="font-medium text-foreground">{grantedCount} / {projects.length}</div>
              <div>허용됨</div>
            </div>
          ) : null}
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-3">
        {message && (
          <Alert variant={message.type === 'success' ? 'success' : 'destructive'}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="space-y-1 divide-y divide-border">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-3">
                <div className="h-4 w-32 flex-1 animate-pulse rounded bg-muted" />
                <div className="h-7 w-20 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
            접근 가능한 프로젝트가 없습니다.
          </p>
        ) : (
          <div className="max-h-72 divide-y divide-border overflow-y-auto overflow-x-hidden rounded-md border border-border">
            {projects.map((project) => {
              const readDenied = readDeniedIds.has(project.id);
              const granted = project.id in grantMap;
              const toggling = togglingId === project.id;
              return (
                <div key={project.id} className="flex items-center justify-between gap-3 px-3 py-3 text-sm">
                  <span className="min-w-0 truncate font-medium text-foreground">{project.name}</span>
                  {readDenied ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                      title="이 프로젝트의 접근 상태를 조회할 권한이 없습니다."
                    >
                      확인 권한 없음
                    </span>
                  ) : canEdit ? (
                    <Button
                      variant="glass"
                      size="sm"
                      disabled={toggling}
                      onClick={() => void handleToggle(project.id)}
                      className={cn(
                        'min-w-[72px] shrink-0 gap-1 transition-colors',
                        granted
                          ? 'border-success/40 bg-success-tint text-success hover:bg-success/15'
                          : 'border-border text-muted-foreground hover:bg-muted/40',
                      )}
                    >
                      {toggling ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : granted ? (
                        <><Shield className="h-3 w-3" />허용</>
                      ) : (
                        <><ShieldOff className="h-3 w-3" />차단</>
                      )}
                    </Button>
                  ) : (
                    <span className={cn(
                      'inline-flex shrink-0 items-center gap-1 text-xs',
                      granted ? 'text-success' : 'text-muted-foreground',
                    )}>
                      {granted ? <Shield className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
                      {granted ? '허용' : '차단'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
