'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Badge } from '@/components/ui/badge';
import { MemberRow } from '@/components/ui/member-row';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

import { fetchWithAuth } from '@/lib/db/client';

interface OrgMember {
  id: string;
  name: string;
  email?: string;
  role: 'owner' | 'admin' | 'member';
}

const ROLE_ORDER = ['owner', 'admin', 'member'] as const;
const ROLE_LABEL_KEY: Record<(typeof ROLE_ORDER)[number], string> = {
  owner: 'roleGroupOwner',
  admin: 'roleGroupAdmin',
  member: 'roleGroupMember',
};

export default function OrganizationRolesPage() {
  const { orgId, orgMemberships } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';
  const isOwner = currentRole === 'owner';
  // story #3231(카디르 버그사냥) — 이 페이지가 email 포함 전체 로스터를 role 무관하게
  // 항상 렌더해, Member 신분도 조직 전원의 실명+이메일을 볼 수 있었다. BE(GET
  // /api/v2/org-members)를 admin/owner 전용 403으로 잠근 것이 실 정본이고, 이건 그
  // 서버 거부를 빈 화면/에러 토스트 대신 명확한 안내로 바꾸는 UX층일 뿐이다(FE 숨김이
  // 아니라 — 이 체크를 빼도 fetchWithAuth가 그냥 403을 받아 members가 비는 것으로
  // 저하될 뿐, 데이터가 새지는 않는다).
  const canView = currentRole === 'owner' || currentRole === 'admin';
  const t = useTranslations('organization');

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [changingId, setChangingId] = useState<string | null>(null);

  const refresh = async () => {
    const res = await fetchWithAuth('/api/org-members').catch(() => null);
    if (res?.ok) {
      const json = await res.json() as { data?: Array<{ id: string; name?: string | null; email?: string | null; role: 'owner' | 'admin' | 'member'; user_id?: string }> };
      setMembers((json.data ?? []).map((m) => ({
        id: m.id,
        name: (m.name?.trim() || null) ?? m.email?.split('@')[0] ?? m.user_id?.slice(0, 8) ?? '?',
        email: m.email ?? undefined,
        role: m.role,
      })));
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!canView) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    void refresh();
  }, [canView]);

  const handleChangeRole = async (memberId: string, newRole: 'admin' | 'member') => {
    setChangingId(memberId);
    await fetch(`/api/org-members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    }).catch(() => null);
    await refresh();
    setChangingId(null);
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-3 p-6">
        {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
      </div>
    );
  }

  if (!canView) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <SectionCard>
          <SectionCardBody>
            <p className="text-sm font-medium text-foreground">{t('rolesAdminOnly')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('rolesAdminOnlyHint')}</p>
          </SectionCardBody>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{t('rolesTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('rolesDescription')}</p>
      </div>

      {ROLE_ORDER.map((role) => {
        const group = members.filter((m) => m.role === role);
        return (
          <SectionCard key={role}>
            <SectionCardHeader>
              <h2 className="text-base font-semibold text-foreground">
                {t(ROLE_LABEL_KEY[role])} ({group.length})
              </h2>
            </SectionCardHeader>
            <SectionCardBody>
              {group.length > 0 ? (
                <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
                  {group.map((member) => {
                    const isThisOwner = member.role === 'owner';
                    const canEdit = isOwner && !isThisOwner;
                    return (
                      <MemberRow
                        key={member.id}
                        name={member.name}
                        email={member.email}
                        className="border-0 rounded-none bg-transparent"
                        actions={
                          canEdit ? (
                            <select
                              className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                              value={member.role}
                              disabled={changingId === member.id}
                              onChange={(e) => void handleChangeRole(member.id, e.target.value as 'admin' | 'member')}
                            >
                              <option value="admin">Admin</option>
                              <option value="member">Member</option>
                            </select>
                          ) : (
                            <Badge variant={isThisOwner ? 'info' : 'secondary'} className="capitalize">{member.role}</Badge>
                          )
                        }
                      />
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('roleGroupEmpty')}</p>
              )}
            </SectionCardBody>
          </SectionCard>
        );
      })}
    </div>
  );
}
