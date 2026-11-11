'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Shield, ShieldOff, Loader2 } from 'lucide-react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { SettingsSection } from './settings-section';
import { Tag } from './settings-parts';
import { cn } from '@/lib/utils';

import { fetchWithAuth } from '@/lib/db/client';
import { orgRoleLabel } from '@/lib/org-member-role';

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
  const t = useTranslations('settings');
  const tc = useTranslations('common');
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
          setMessage({ type: 'success', text: t('projectMemberTakeOff', { name: member.name }) });
          await refreshData();
        } else {
          setMessage({ type: 'error', text: t('projectAccessRevokeFailed') });
        }
      } else {
        // 허용 — POST grant
        const res = await fetchWithAuth(`/api/projects/${projectId}/access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ org_member_id: member.id, role: member.role }),
        });
        if (res.ok) {
          setMessage({ type: 'success', text: t('projectMemberPutOn', { name: member.name }) });
          await refreshData();
        } else {
          setMessage({ type: 'error', text: t('projectAccessGrantFailed') });
        }
      }
    } finally {
      setTogglingId(null);
    }
  };

  if (loading) {
    return (
      <SettingsSection title={t('projectAccessTitle')} description={tc('loading')}>
        <SkeletonGroup label={tc('loading')} className="divide-y divide-ds-line">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-3">
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-7 w-20" />
            </div>
          ))}
        </SkeletonGroup>
      </SettingsSection>
    );
  }

  if (!canManage) {
    // canManage=false는 이제 project-access-candidates가 403(또는 실패)했다는 실측
    // 결과다 — org-level currentRole 추정이 아니라 서버가 이 프로젝트의 effective
    // 관리자가 아니라고 실제로 거부한 경우에만 이 안내가 뜬다.
    return (
      <SettingsSection title={t('projectAccessTitle')}>
        {/* story #3776(1층B) — "관리자 전용 페이지입니다", settings ns의 기존 orgMembersAdminOnly 키 재사용. */}
        <p className="text-ds-body font-medium text-ds-ink">{t('orgMembersAdminOnly')}</p>
        <p className="text-ds-body text-ds-ink-3">{t('projectAccessAdminOnlyDesc')}</p>
      </SettingsSection>
    );
  }

  const grantedCount = grants.length;
  const totalCount = orgMembers.length;

  return (
    <SettingsSection
      title={t('projectAccessTitle')}
      description={t('projectAccessSubtitle')}
    >
      <div className="text-right text-ds-small text-ds-ink-3 tabular-nums">
        <span className="font-medium text-ds-ink">{grantedCount} / {totalCount}</span> {t('projectAccessGrantedLabel')}
      </div>
      {message && (
        // story #2105 2차 — handleToggle이 재시도 전 setMessage(null)을 먼저 호출해(위 정의) 매
        // 시도마다 언마운트→리마운트된다. 에러=alert, 성공=status(ds Banner의 역할 규칙).
        <Banner tone={message.type === 'success' ? 'info' : 'failed'}>{message.text}</Banner>
      )}

      {orgMembers.length === 0 ? (
        <p className="rounded-ds-control border border-dashed border-ds-line px-3 py-6 text-ds-body text-ds-ink-3">
          {t('noOrgMembersInviteFirst')}
        </p>
      ) : (
        <div className="divide-y divide-ds-line overflow-hidden rounded-ds-control border border-ds-line">
          {orgMembers.map((member) => {
            const grant = getGrant(member.id);
            const granted = !!grant;
            const isOwner = member.role === 'owner';   // org owner = always granted, 토글 불가
            const toggling = togglingId === member.id;

            return (
              <div
                key={member.id}
                className={cn(
                  'flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5 transition-opacity duration-200',
                  !granted && !isOwner && 'opacity-60',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ds-body font-medium text-ds-ink">{member.name}</div>
                  {member.email ? <div className="truncate text-ds-small text-ds-ink-3">{member.email}</div> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {granted && grant ? (
                    <Tag>{orgRoleLabel(grant.role, t)}</Tag>
                  ) : isOwner ? (
                    <Tag tone="action">{orgRoleLabel(member.role, t)}</Tag>
                  ) : null}
                  {isOwner ? (
                    <span className="inline-flex items-center gap-1 text-ds-small text-ds-ink-3">
                      <Shield className="h-3 w-3" />
                      {t('projectAccessAlwaysAllowed')}
                    </span>
                  ) : canManage ? (
                    <Button
                      variant={granted ? 'primary' : 'secondary'}
                      disabled={toggling}
                      onClick={() => void handleToggle(member)}
                      className="min-w-[72px] gap-1"
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
                    <span className={cn('inline-flex items-center gap-1 text-ds-small', granted ? 'text-ds-done' : 'text-ds-ink-3')}>
                      {granted ? <Shield className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
                      {granted ? t('projectAccessAllowed') : t('projectAccessBlocked')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}
