'use client';

import { useEffect, useState } from 'react';
import { Shield, ShieldOff, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MemberRow } from '@/components/ui/member-row';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';

import { fetchWithAuth } from '@/lib/db/client';

interface OrgMember {
  id: string;            // org_member.id
  user_id: string;
  name: string;
  email?: string;
  role: 'owner' | 'admin' | 'member';     // org-level role
}

interface ProjectGrant {
  id: string;             // grant record id
  org_member_id: string;
  role: 'owner' | 'admin' | 'member';     // project-level role
}

interface ProjectAccessSectionProps {
  projectId: string;
}

export function ProjectAccessSection({ projectId }: ProjectAccessSectionProps) {
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [grants, setGrants] = useState<ProjectGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // story #3231 4라운드(카디르 QA) — 2라운드에서 이 화면을 org-admin 전용(currentRole
  // prop 기반)으로 잠갔는데, 실제 인가 경계는 org-admin이 아니라 "이 프로젝트의
  // effective 관리자"(org owner/admin 플로어 OR project-level owner/admin — additive,
  // BE _require_owner_or_admin/has_project_role)였다. org-admin은 아니지만 이 project의
  // admin/owner인 org member가 새로 막혔던 신규 회귀. FE에서 effective 역할을 별도로
  // 재계산(중복 판정 — 두 곳이 갈리는 사고 클래스)하는 대신, project-access-candidates
  // 응답 자체(요청한 그 게이트를 서버가 이미 통과시켰는지)로 인가 여부를 판정한다 —
  // "roster 조회 인가 = 그걸 쓰는 액션의 인가와 동일"(카디르 원칙)이 서버 쪽에서 이미
  // 성립하므로, 이 fetch가 성공했다는 사실 자체가 곧 canManage다.
  const canManage = !unauthorized;

  const refreshData = async () => {
    setLoading(true);
    const [membersRes, grantsRes] = await Promise.all([
      fetchWithAuth(`/api/projects/${projectId}/access-candidates`).catch(() => null),
      fetchWithAuth(`/api/projects/${projectId}/access`).catch(() => null),
    ]);
    if (membersRes?.ok) {
      const json = await membersRes.json() as { data?: OrgMember[] };
      setOrgMembers(json.data ?? []);
      setUnauthorized(false);
    } else {
      setUnauthorized(true);
    }
    if (grantsRes?.ok) {
      const json = await grantsRes.json() as { data?: ProjectGrant[] };
      setGrants(json.data ?? []);
    }
    setLoading(false);
  };

  useEffect(() => {
    void refreshData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const getGrant = (orgMemberId: string) =>
    grants.find((g) => g.org_member_id === orgMemberId);

  const handleToggle = async (member: OrgMember) => {
    if (!canManage || togglingId) return;
    setTogglingId(member.id);
    setMessage(null);

    const existing = getGrant(member.id);
    try {
      if (existing) {
        // 차단 — DELETE grant
        const res = await fetchWithAuth(`/api/projects/${projectId}/access/${existing.id}`, { method: 'DELETE' });
        if (res.ok) {
          setMessage({ type: 'success', text: `${member.name} 접근 권한 해제됨` });
          await refreshData();
        } else {
          setMessage({ type: 'error', text: '권한 해제 실패' });
        }
      } else {
        // 허용 — POST grant
        const res = await fetchWithAuth(`/api/projects/${projectId}/access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ org_member_id: member.id, role: member.role }),
        });
        if (res.ok) {
          setMessage({ type: 'success', text: `${member.name} 접근 권한 부여됨` });
          await refreshData();
        } else {
          setMessage({ type: 'error', text: '권한 부여 실패' });
        }
      }
    } finally {
      setTogglingId(null);
    }
  };

  if (loading) {
    return (
      <SectionCard>
        <SectionCardHeader>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">접근 권한</h2>
            <p className="text-sm text-muted-foreground">불러오는 중...</p>
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          <div className="space-y-1 divide-y divide-border">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-3">
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-48 animate-pulse rounded bg-muted/60" />
                </div>
                <div className="h-7 w-20 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        </SectionCardBody>
      </SectionCard>
    );
  }

  if (!canManage) {
    // canManage=false는 이제 project-access-candidates가 403(또는 실패)했다는 실측
    // 결과다 — org-level currentRole 추정이 아니라 서버가 이 프로젝트의 effective
    // 관리자가 아니라고 실제로 거부한 경우에만 이 안내가 뜬다.
    return (
      <SectionCard>
        <SectionCardHeader>
          <h2 className="text-base font-semibold text-foreground">접근 권한</h2>
        </SectionCardHeader>
        <SectionCardBody>
          <p className="text-sm font-medium text-foreground">관리자 전용 페이지입니다</p>
          <p className="mt-1 text-sm text-muted-foreground">이 프로젝트의 관리자·소유자만 접근 권한을 관리할 수 있습니다.</p>
        </SectionCardBody>
      </SectionCard>
    );
  }

  const grantedCount = grants.length;
  const totalCount = orgMembers.length;

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">접근 권한</h2>
            <p className="text-sm text-muted-foreground">
              조직 구성원 중 본 프로젝트 접근을 허용한 사람을 선택합니다.
            </p>
          </div>
          <div className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
            <div className="font-medium text-foreground">{grantedCount} / {totalCount}</div>
            <div>허용됨</div>
          </div>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-3">
        {message && (
          // story #2105 2차 — handleToggle이 재시도 전 setMessage(null)을 먼저 호출해(위 정의) 매
          // 시도마다 언마운트→리마운트된다. 에러=alert/assertive, 성공=status/polite.
          <Alert
            variant={message.type === 'success' ? 'success' : 'destructive'}
            role={message.type === 'success' ? 'status' : 'alert'}
            aria-live={message.type === 'success' ? 'polite' : 'assertive'}
            aria-atomic="true"
          >
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}

        {orgMembers.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
            조직 구성원이 없습니다. 조직 구성원 탭에서 먼저 초대하세요.
          </p>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {orgMembers.map((member) => {
              const grant = getGrant(member.id);
              const granted = !!grant;
              const isOwner = member.role === 'owner';   // org owner = always granted, 토글 불가
              const toggling = togglingId === member.id;

              return (
                <MemberRow
                  key={member.id}
                  name={member.name}
                  email={member.email}
                  className={cn(
                    'border-0 rounded-none bg-transparent transition-opacity duration-200',
                    !granted && !isOwner && 'opacity-60',
                  )}
                  actions={
                    <>
                      {granted && grant ? (
                        <Badge variant="outline" className="capitalize text-xs">
                          {grant.role}
                        </Badge>
                      ) : isOwner ? (
                        <Badge variant="info" className="capitalize text-xs">
                          {member.role}
                        </Badge>
                      ) : null}
                      {isOwner ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Shield className="h-3 w-3" />
                          상시 허용
                        </span>
                      ) : canManage ? (
                        <Button
                          variant="glass"
                          size="sm"
                          disabled={toggling}
                          onClick={() => void handleToggle(member)}
                          className={cn(
                            'min-w-[72px] gap-1 transition-colors',
                            // story #2590(TIER3) — tint 위 계열색 글자는 text-foreground(#2420 규칙).
                            granted
                              ? 'border-success/40 bg-success-tint text-foreground hover:bg-success/15'
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
                          'inline-flex items-center gap-1 text-xs',
                          granted ? 'text-success' : 'text-muted-foreground',
                        )}>
                          {granted ? <Shield className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
                          {granted ? '허용' : '차단'}
                        </span>
                      )}
                    </>
                  }
                />
              );
            })}
          </div>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
