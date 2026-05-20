'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Badge } from '@/components/ui/badge';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';

interface OrgMember {
  id: string;
  user_id: string | null;
  name: string;
  email?: string;
  role: 'owner' | 'admin' | 'member';
  joined_at?: string;
}

interface OrgInvite {
  id: string;
  email: string;
  role: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  expires_at: string;
  invite_url?: string;
}

interface OrgMembersSectionProps {
  orgId: string;
  currentRole: string;
}

export function OrgMembersSection({ orgId, currentRole }: OrgMembersSectionProps) {
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invites, setInvites] = useState<OrgInvite[]>([]);
  const [loading, setLoading] = useState(true);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [removingId, setRemovingId] = useState<string | null>(null);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState<string | null>(null);
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const canManage = currentRole === 'owner' || currentRole === 'admin';
  const isOwner = currentRole === 'owner';

  const refreshData = async () => {
    const [membersRes, invitesRes] = await Promise.all([
      fetch(`/api/organizations/${orgId}/members`).catch(() => null),
      fetch(`/api/organizations/${orgId}/invites`).catch(() => null),
    ]);
    if (membersRes?.ok) {
      const json = await membersRes.json() as { data?: OrgMember[] };
      setMembers(json.data ?? []);
    }
    if (invitesRes?.ok) {
      const json = await invitesRes.json() as { data?: OrgInvite[] };
      setInvites((json.data ?? []).filter((i) => i.status === 'pending'));
    }
    setLoading(false);
  };

  useEffect(() => {
    void refreshData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const handleInvite = async () => {
    if (!inviteEmail.trim() || inviting) return;
    setInviting(true);
    setInviteResult(null);
    const res = await fetch(`/api/organizations/${orgId}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
    });
    const json = await res.json() as { data?: { invite_url?: string }; error?: { message?: string } };
    if (!res.ok) {
      setInviteResult({ type: 'error', text: json.error?.message ?? '초대 발송에 실패했습니다.' });
    } else {
      setInviteResult({ type: 'success', text: `초대 발송 완료${json.data?.invite_url ? ` — ${json.data.invite_url}` : ''}` });
      setInviteEmail('');
      await refreshData();
    }
    setInviting(false);
  };

  const handleChangeRole = async (memberId: string, newRole: 'admin' | 'member') => {
    setChangingRoleId(memberId);
    setActionMessage(null);
    const res = await fetch(`/api/organizations/${orgId}/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) {
      setActionMessage({ type: 'success', text: '역할이 변경됐습니다.' });
      await refreshData();
    } else {
      const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setActionMessage({ type: 'error', text: json?.error?.message ?? '역할 변경에 실패했습니다.' });
    }
    setChangingRoleId(null);
  };

  const handleRemove = async (memberId: string) => {
    setRemovingId(memberId);
    setActionMessage(null);
    const res = await fetch(`/api/organizations/${orgId}/members/${memberId}`, { method: 'DELETE' });
    if (res.ok) {
      setActionMessage({ type: 'success', text: '멤버가 제거됐습니다.' });
      setShowRemoveConfirm(null);
      await refreshData();
    } else {
      const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setActionMessage({ type: 'error', text: json?.error?.message ?? '멤버 제거에 실패했습니다.' });
    }
    setRemovingId(null);
  };

  const handleResendInvite = async (inviteId: string) => {
    setResendingId(inviteId);
    await fetch(`/api/organizations/${orgId}/invites/${inviteId}/resend`, { method: 'POST' }).catch(() => null);
    setResendingId(null);
    await refreshData();
  };

  const handleRevokeInvite = async (inviteId: string) => {
    setRevokingId(inviteId);
    await fetch(`/api/organizations/${orgId}/invites/${inviteId}`, { method: 'DELETE' }).catch(() => null);
    setRevokingId(null);
    await refreshData();
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 초대 폼 */}
      {canManage && (
        <SectionCard>
          <SectionCardHeader>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">멤버 초대</h2>
              <p className="text-sm text-muted-foreground">이메일로 Organization에 초대합니다.</p>
            </div>
          </SectionCardHeader>
          <SectionCardBody className="space-y-4">
            <div className="flex flex-col gap-3 md:flex-row">
              <OperatorInput
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="email@example.com"
              />
              <OperatorDropdownSelect
                value={inviteRole}
                onValueChange={(v) => setInviteRole(v as 'admin' | 'member')}
                options={[
                  { value: 'member', label: 'Member' },
                  { value: 'admin', label: 'Admin' },
                ]}
              />
              <Button variant="hero" size="lg" onClick={() => void handleInvite()} disabled={!inviteEmail.trim() || inviting}>
                {inviting ? '...' : '초대'}
              </Button>
            </div>
            {inviteResult && (
              <div className={`rounded-md border p-3 text-xs break-all ${inviteResult.type === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-destructive/20 bg-destructive/10 text-destructive'}`}>
                {inviteResult.text}
              </div>
            )}
          </SectionCardBody>
        </SectionCard>
      )}

      {/* 액션 메시지 */}
      {actionMessage && (
        <div className={`rounded-md border p-3 text-xs ${actionMessage.type === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-destructive/20 bg-destructive/10 text-destructive'}`}>
          {actionMessage.text}
        </div>
      )}

      {/* 멤버 목록 */}
      <SectionCard>
        <SectionCardHeader>
          <h2 className="text-base font-semibold text-foreground">멤버 ({members.length})</h2>
        </SectionCardHeader>
        <SectionCardBody className="space-y-2">
          {members.map((member) => {
            const isThisOwner = member.role === 'owner';
            const canEdit = isOwner && !isThisOwner;
            return (
              <div key={member.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-3 text-sm">
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{member.name}</div>
                  {member.email && <div className="text-xs text-muted-foreground">{member.email}</div>}
                  {member.joined_at && (
                    <div className="text-xs text-muted-foreground">
                      {new Date(member.joined_at).toLocaleDateString('ko-KR')} 가입
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {canEdit ? (
                    <select
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                      value={member.role}
                      disabled={changingRoleId === member.id}
                      onChange={(e) => void handleChangeRole(member.id, e.target.value as 'admin' | 'member')}
                    >
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                    </select>
                  ) : (
                    <Badge variant={isThisOwner ? 'info' : 'secondary'} className="capitalize">{member.role}</Badge>
                  )}
                  {canEdit && (
                    showRemoveConfirm === member.id ? (
                      <div className="flex gap-1">
                        <Button size="sm" variant="destructive" onClick={() => void handleRemove(member.id)} disabled={removingId === member.id}>
                          {removingId === member.id ? '...' : '확인'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setShowRemoveConfirm(null)}>취소</Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="glass" onClick={() => setShowRemoveConfirm(member.id)}>
                        제거
                      </Button>
                    )
                  )}
                </div>
              </div>
            );
          })}
          {members.length === 0 && (
            <p className="text-sm text-muted-foreground">멤버가 없습니다.</p>
          )}
        </SectionCardBody>
      </SectionCard>

      {/* 초대 대기 목록 */}
      {invites.length > 0 && (
        <SectionCard>
          <SectionCardHeader>
            <h2 className="text-base font-semibold text-foreground">초대 대기 ({invites.length})</h2>
          </SectionCardHeader>
          <SectionCardBody className="space-y-2">
            {invites.map((invite) => (
              <div key={invite.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs">
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{invite.email}</div>
                  <div className="text-muted-foreground">
                    {invite.role} · 만료: {new Date(invite.expires_at).toLocaleDateString('ko-KR')}
                  </div>
                </div>
                {canManage && (
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="glass" disabled={resendingId === invite.id} onClick={() => void handleResendInvite(invite.id)}>
                      {resendingId === invite.id ? '...' : '재발송'}
                    </Button>
                    <Button size="sm" variant="glass" disabled={revokingId === invite.id} onClick={() => void handleRevokeInvite(invite.id)}
                      className="text-destructive hover:bg-destructive/10">
                      {revokingId === invite.id ? '...' : '취소'}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </SectionCardBody>
        </SectionCard>
      )}
    </div>
  );
}
