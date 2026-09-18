'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, ChevronDown, Copy } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { MemberRow } from '@/components/ui/member-row';
import { RemoveOrgMemberDialog } from '@/components/settings/remove-org-member-dialog';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Badge } from '@/components/ui/badge';
import { CountBadge } from '@/components/ui/count-badge';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { useRenderNonce } from '@/hooks/use-render-nonce';

import { fetchWithAuth } from '@/lib/db/client';
import { canEditOrgMemberRole, orgRoleLabel } from '@/lib/org-member-role';
import { formatRelativeTime } from '@/lib/storage/format';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';

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

  const t = useTranslations('settings');
  // story #3606(잔여, 페드루 PO 確定 2026-09-07) — common.cancel·share.copyLink는
  // 기존 키 재사용(새 낱말 0, §22-18 원칙과 동형).
  const tc = useTranslations('common');
  const tShare = useTranslations('share');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 정책B(05fa365f): 초대 시 부여할 프로젝트 선택(멀티). 0개=미지정(조직만).
  const [inviteProjectIds, setInviteProjectIds] = useState<string[]>([]);
  const [orgProjects, setOrgProjects] = useState<{ id: string; name: string }[]>([]);
  const [showProjectPicker, setShowProjectPicker] = useState(false);

  const toggleInviteProject = (id: string) => {
    setInviteProjectIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const [removeDialogMemberId, setRemoveDialogMemberId] = useState<string | null>(null);
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // story #2154 — handleCopyInviteLink의 catch 경로가 setActionMessage(null) 리셋 없이 바로
  // 세팅해, 연속 동일 실패(예: 클립보드 반복 실패) 시 재낭독이 안 될 수 있던 것을 nonce-key로
  // 구조적으로 막는다.
  const [actionMessageNonce, bumpActionMessageNonce] = useRenderNonce();
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);

  const canManage = currentRole === 'owner' || currentRole === 'admin';
  // story #3491(페드루 PO 確定) — canEditOrgMemberRole의 자기 자신 판정에 필요.
  // BE MeResponse.user_id(=members.user_id 축, project-scoped team member id인
  // currentTeamMemberId와는 다른 값)와 org-members 응답의 user_id를 대조한다.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const refreshData = async () => {
    const [membersRes, invitesRes, projectsRes, meRes] = await Promise.all([
      fetchWithAuth('/api/org-members').catch(() => null),
      fetchWithAuth(`/api/organizations/${orgId}/invites`).catch(() => null),
      fetchWithAuth('/api/projects').catch(() => null),
      fetchWithAuth('/api/me').catch(() => null),
    ]);
    if (meRes?.ok) {
      const json = await meRes.json() as { data?: { user_id?: string | null } };
      setCurrentUserId(json.data?.user_id ?? null);
    }
    if (projectsRes?.ok) {
      const json = await projectsRes.json() as { data?: Array<{ id: string; name: string }> };
      setOrgProjects((json.data ?? []).map((p) => ({ id: p.id, name: p.name })));
    }
    if (membersRes?.ok) {
      const raw = await membersRes.json() as { data?: Array<{ id: string; user_id: string; name?: string | null; email?: string | null; role: 'owner' | 'admin' | 'member'; created_at: string }> };
      setMembers((raw.data ?? []).map((m) => ({
        id: m.id,
        user_id: m.user_id,
        name: (m.name?.trim() || null) ?? m.email?.split('@')[0] ?? m.user_id?.slice(0, 8) ?? '?',
        email: m.email ?? undefined,
        role: m.role,
        joined_at: m.created_at,
      })));
    }
    if (invitesRes?.ok) {
      const json = await invitesRes.json() as { data?: OrgInvite[] };
      setInvites((json.data ?? []).filter((i) => i.status === 'pending'));
    }
    setLoading(false);
  };

  useEffect(() => {
    // story #3231(카디르 버그사냥) — 이 섹션(Members 페이지+settings「org-members」탭
    // 공용)이 role 무관하게 email 포함 전체 로스터를 항상 렌더해, Member 신분도 조직
    // 전원의 실명+이메일을 볼 수 있었다. BE(GET /api/v2/org-members)를 admin/owner
    // 전용 403으로 잠근 것이 실 정본 — 이건 그 서버 거부를 안내 문구로 바꾸는 UX층일
    // 뿐(FE 숨김이 아니라, 이 체크를 빼도 데이터가 새지는 않는다). 이 컴포넌트 전체가
    // 초대/역할변경/제거 등 관리 UI라 Member에겐 어떤 하위 데이터도 정당한 용도가
    // 없어 섹션 전체를 잠근다(부분 마스킹이 아니라 전면).
    if (!canManage) {
      setLoading(false);
      return;
    }
    void refreshData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, canManage]);

  const handleInvite = async () => {
    if (!inviteEmail.trim() || inviting) return;
    setInviting(true);
    setInviteResult(null);
    const res = await fetchWithAuth(`/api/organizations/${orgId}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole, project_ids: inviteProjectIds }),
    });
    const json = await res.json() as {
      data?: { invite_url?: string };
      error?: { code?: string; message?: string; limit?: number };
    };
    if (!res.ok) {
      // story #2485 — EE plan_limits.check_member_invite_limit()가 실제로 이 code를
      // 낸다(그라운딩 확認). 그 외 code는 backend가 generic HTTP상태만 준다 — raw
      // 서버 message 노출 대신 고정 문구.
      if (json.error?.code === 'PLAN_LIMIT_EXCEEDED') {
        setInviteResult({ type: 'error', text: t('memberLimitExceededError', { limit: json.error.limit ?? 1 }) });
      } else {
        setInviteResult({ type: 'error', text: t('memberInviteFailed') });
      }
    } else {
      setInviteResult({ type: 'success', text: `${t('orgMemberInviteSuccess')}${json.data?.invite_url ? ` — ${json.data.invite_url}` : ''}` });
      setInviteEmail('');
      setInviteProjectIds([]);
      setShowProjectPicker(false);
      await refreshData();
    }
    setInviting(false);
  };

  const handleChangeRole = async (memberId: string, newRole: 'admin' | 'member') => {
    setChangingRoleId(memberId);
    setActionMessage(null);
    const res = await fetch(`/api/org-members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) {
      setActionMessage({ type: 'success', text: t('orgMemberRoleChangeSuccess') });
      await refreshData();
    } else {
      // story #3491 — update_org_member()가 이제 owner 보호 가드의 구조화 code를
      // 낸다(ORG_MEMBER_OWNER_ONLY_ACTION·ORG_LAST_OWNER, story #2485 코멘트가 말한
      // "진짜 비즈니스 code 없음" 시절은 지났다). FE 게이트가 canEditOrgMemberRole로
      // 대부분 막지만, 다른 창에서 동시에 상태가 바뀌는 race는 남아 있어 서버 거부를
      // 그대로 안내해야 한다(raw 서버 message 노출은 여전히 안 함, 고정 문구로).
      const json = await res.json().catch(() => null) as { error?: { code?: string } } | null;
      if (json?.error?.code === 'ORG_MEMBER_OWNER_ONLY_ACTION') {
        setActionMessage({ type: 'error', text: t('memberRoleChangeOwnerOnlyError') });
      } else if (json?.error?.code === 'ORG_LAST_OWNER') {
        setActionMessage({ type: 'error', text: t('memberRoleChangeLastOwnerError') });
      } else {
        setActionMessage({ type: 'error', text: t('memberRoleChangeFailed') });
      }
    }
    setChangingRoleId(null);
  };

  const handleRemove = async (memberId: string) => {
    setActionMessage(null);
    const res = await fetch(`/api/org-members/${memberId}`, { method: 'DELETE' });
    if (res.ok) {
      setActionMessage({ type: 'success', text: t('orgMemberRemoveSuccess') });
      await refreshData();
    } else {
      // story #2485 — backend delete_org_member()는 generic HTTP상태 코드만 낸다
      // (진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 대신 고정 문구.
      setActionMessage({ type: 'error', text: t('memberRemoveFailed') });
    }
  };

  const handleResendInvite = async (inviteId: string) => {
    setResendingId(inviteId);
    await fetchWithAuth(`/api/organizations/${orgId}/invites/${inviteId}/resend`, { method: 'POST' }).catch(() => null);
    setResendingId(null);
    await refreshData();
  };

  const handleRevokeInvite = async (inviteId: string) => {
    setRevokingId(inviteId);
    await fetchWithAuth(`/api/organizations/${orgId}/invites/${inviteId}`, { method: 'DELETE' }).catch(() => null);
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

  if (!canManage) {
    return (
      <SectionCard>
        <SectionCardBody>
          <p className="text-sm font-medium text-foreground">{t('orgMembersAdminOnly')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('orgMembersAdminOnlyHint')}</p>
        </SectionCardBody>
      </SectionCard>
    );
  }

  const handleCopyInviteLink = async (inviteId: string, url: string | undefined) => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedInviteId(inviteId);
      setTimeout(() => setCopiedInviteId(null), 1500);
    } catch {
      bumpActionMessageNonce();
      setActionMessage({ type: 'error', text: t('orgMemberClipboardCopyFailed') });
    }
  };

  return (
    <div className="space-y-6">
      {/* 초대 폼 */}
      {canManage && (
        <SectionCard>
          <SectionCardHeader>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">{t('orgMembersHeading')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('orgMembersInviteDescription')}
              </p>
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
                  { value: 'member', label: t('roleMember') },
                  { value: 'admin', label: t('roleAdmin') },
                ]}
              />
              <Button variant="hero" size="lg" onClick={() => void handleInvite()} disabled={!inviteEmail.trim() || inviting}>
                {inviting ? '...' : t('invite')}
              </Button>
            </div>

            {/* 정책B(05fa365f): 프로젝트 멀티선택 — 0개=미지정(조직만) */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{t('inviteProjectsLabel')}</p>
              {orgProjects.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('inviteProjectsEmpty')}</p>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setShowProjectPicker((v) => !v)}
                    className="flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-left text-sm text-foreground transition hover:bg-muted/50 md:max-w-sm"
                  >
                    <span className={inviteProjectIds.length === 0 ? 'text-muted-foreground' : ''}>
                      {inviteProjectIds.length === 0
                        ? t('inviteProjectsTrigger')
                        : t('inviteProjectsCount', { count: inviteProjectIds.length })}
                    </span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${showProjectPicker ? 'rotate-180' : ''}`} />
                  </button>
                  {showProjectPicker && (
                    <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-1 md:max-w-sm">
                      {orgProjects.map((p) => {
                        const selected = inviteProjectIds.includes(p.id);
                        return (
                          <li key={p.id}>
                            <button
                              type="button"
                              onClick={() => toggleInviteProject(p.id)}
                              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition ${
                                selected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'
                              }`}
                            >
                              <span className="flex-1 truncate">{p.name}</span>
                              {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
              <p className="text-xs text-muted-foreground">{t('inviteProjectsHelper')}</p>
            </div>

            {inviteResult && (
              // story #2105 2차 — handleInvite가 재시도 전 setInviteResult(null)을 먼저 호출해(위
              // 정의) 매 시도마다 언마운트→리마운트된다. 에러=alert/assertive, 성공=status/polite.
              <Alert
                variant={inviteResult.type === 'success' ? 'success' : 'destructive'}
                role={inviteResult.type === 'success' ? 'status' : 'alert'}
                aria-live={inviteResult.type === 'success' ? 'polite' : 'assertive'}
                aria-atomic="true"
              >
                <AlertDescription className="break-all">{inviteResult.text}</AlertDescription>
              </Alert>
            )}
          </SectionCardBody>
        </SectionCard>
      )}

      {actionMessage && (
        <Alert
          key={actionMessageNonce}
          variant={actionMessage.type === 'success' ? 'success' : 'destructive'}
        >
          <AlertDescription>{actionMessage.text}</AlertDescription>
        </Alert>
      )}

      {/* 멤버 목록 */}
      <SectionCard>
        <SectionCardHeader>
          {/* story #3735(UI 점검 B·E절, 유나 定) — 수를 제목 문자열 안에 넣지 않는다.
              제목 고정 + 수는 옆 CountBadge로(이벤트 화면 events/page.tsx와 동형). */}
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            {t('orgMembersListHeading')}
            <CountBadge count={members.length} />
          </h2>
        </SectionCardHeader>
        <SectionCardBody>
          {/* HARD 픽셀 딴판 fix: 박시 per-member 카드 → project-access와 동일 de-boxy divide-y(공유 MemberRow flat·양 surface 정합) */}
          {members.length > 0 ? (
          <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {/* story #3592(§17-20 ⑧·§22-18 동형) — 행마다 같은 「제거」 접근 이름이라
              보조기술 버튼 목록에서 어느 멤버 행인지 못 가른다. story #3606(잔여,
              페드루 PO 確定 2026-09-07)에서 이 파일 전체 하드코딩 한글을 마저
              i18n 키화했다(기존 키 재사용 우선, 새 낱말은 「문자열→키」 표 PR
              본문 참고). */}
          {members.map((member, index) => {
            const isThisOwner = member.role === 'owner';
            const canEdit = canEditOrgMemberRole({ currentRole, currentUserId, member });
            return (
              <MemberRow
                key={member.id}
                name={member.name}
                email={member.email}
                className="border-0 rounded-none bg-transparent"
                meta={member.joined_at ? t('orgMemberJoinedMeta', { time: formatRelativeTime(member.joined_at, locale, displayTimezone) }) : undefined}
                actions={
                  // story #3771(PO 별건 ㉓·유나 r65) — 역할 열/액션 열을 항상 둘 다 렌더한다
                  // (행마다 열의 뜻이 같게). 역할 변경 불가 행(소유자·자기 자신)은 select 대신
                  // 배지가 서지만, 그 배지가 «제거» 버튼이 있던 자리로 밀려 앉으면 세로로 읽을
                  // 때 상태 딱지와 행동 버튼이 한 열에 섞인다(라이브 캡처로 실측된 결함) — 액션
                  // 열은 canEdit=false일 때도 같은 Button(같은 텍스트·크기, 그래서 폭이 로케일과
                  // 무관하게 정확히 같다)을 invisible로 그려 자리만 지킨다(클릭 불가·
                  // aria-hidden — 보조기술 목록엔 아예 안 나온다).
                  <>
                    {canEdit ? (
                      <select
                        className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                        value={member.role}
                        disabled={changingRoleId === member.id}
                        onChange={(e) => void handleChangeRole(member.id, e.target.value as 'admin' | 'member')}
                      >
                        <option value="admin">{t('roleAdmin')}</option>
                        <option value="member">{t('roleMember')}</option>
                      </select>
                    ) : (
                      <Badge variant={isThisOwner ? 'info' : 'secondary'}>{orgRoleLabel(member.role, t)}</Badge>
                    )}
                    {canEdit ? (
                      <Button
                        size="sm" variant="glass" onClick={() => setRemoveDialogMemberId(member.id)}
                        aria-label={t('orgMemberRowActionAriaLabel', { n: index + 1, label: t('removeFromProject') })}
                      >
                        {t('removeFromProject')}
                      </Button>
                    ) : (
                      // story #3592 회귀 가드(verify-repeated-row-action-names) — aria-hidden이라
                      // 보조기술엔 안 읽혀도 정적 스캔은 행마다 반복되는 라벨을 그대로 잡는다.
                      // 실 버튼과 동일하게 순번을 품은 aria-label을 붙인다(무해 — aria-hidden이
                      // 우선해 결국 안 읽힌다).
                      <Button
                        size="sm" variant="glass" tabIndex={-1} aria-hidden="true"
                        className="invisible pointer-events-none"
                        aria-label={t('orgMemberRowActionAriaLabel', { n: index + 1, label: t('removeFromProject') })}
                      >
                        {t('removeFromProject')}
                      </Button>
                    )}
                  </>
                }
              />
            );
          })}
          </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('orgMembersEmpty')}</p>
          )}
        </SectionCardBody>
      </SectionCard>

      {removeDialogMemberId ? (() => {
        const target = members.find((m) => m.id === removeDialogMemberId);
        if (!target) return null;
        return (
          <RemoveOrgMemberDialog
            open
            member={{ id: target.id, name: target.name, email: target.email }}
            onCancel={() => setRemoveDialogMemberId(null)}
            onConfirm={async () => {
              await handleRemove(target.id);
              setRemoveDialogMemberId(null);
            }}
          />
        );
      })() : null}

      {/* 초대 대기 목록 */}
      {invites.length > 0 && (
        <SectionCard>
          <SectionCardHeader>
            {/* story #3735 CHANGES(유나 재검토) — orgMembersListHeading(:377)만 새 형으로
                옮기고 이 옆 헤더는 옛 괄호 형으로 남겨 같은 화면 안 두 형이 세로로 나란히
                서는 불일치를 만들었다. 같은 처방으로 통일. */}
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              {t('orgInvitesListHeading')}
              <CountBadge count={invites.length} />
            </h2>
          </SectionCardHeader>
          <SectionCardBody>
            <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {/* story #3592(§17-20 ⑧·§22-18 동형)·story #3606(잔여, 페드루 PO 確定
                2026-09-07) — 링크 복사·재발송·취소 aria-label은 기존
                orgInviteRowActionAriaLabel 유지, 하드코딩 한글은 마저 키화(기존
                키(share.copyLink·settings.resend·common.cancel) 재사용 우선). */}
            {invites.map((invite, index) => (
              <MemberRow
                key={invite.id}
                name={invite.email}
                className="border-0 rounded-none bg-transparent"
                meta={t('orgInviteMeta', { role: invite.role, date: formatScheduledAt(invite.expires_at, displayTimezone).display })}
                emphasis="subtle"
                actions={
                  canManage ? (
                    <div className="flex shrink-0 gap-1">
                      {/* story #2590(TIER3) — tint 위 계열색 글자는 text-foreground(#2420 규칙). */}
                      <Button
                        size="sm"
                        variant="glass"
                        disabled={!invite.invite_url}
                        onClick={() => void handleCopyInviteLink(invite.id, invite.invite_url)}
                        title={invite.invite_url ? t('orgInviteCopyLinkTitle') : t('orgInviteCopyLinkUnavailableTitle')}
                        className={copiedInviteId === invite.id ? 'text-foreground bg-success/12 border-success/30' : ''}
                        aria-label={t('orgInviteRowActionAriaLabel', {
                          n: index + 1, label: copiedInviteId === invite.id ? t('orgInviteCopiedLabel') : tShare('copyLink'),
                        })}
                      >
                        {copiedInviteId === invite.id ? (
                          <><Check className="h-3 w-3 mr-1" />{t('orgInviteCopiedLabel')}</>
                        ) : (
                          <><Copy className="h-3 w-3 mr-1" />{tShare('copyLink')}</>
                        )}
                      </Button>
                      <Button
                        size="sm" variant="glass" disabled={resendingId === invite.id} onClick={() => void handleResendInvite(invite.id)}
                        aria-label={t('orgInviteRowActionAriaLabel', { n: index + 1, label: resendingId === invite.id ? t('orgInviteResending') : t('resend') })}
                      >
                        {/* story #3608(유나 §22-18 ④-2)+#3606(i18n화) 병합 — pending
                            "..."는 아무 말도 안 한다(낱말 "재발송 중…"로), 기본 라벨은
                            #3606이 새로 i18n화한 t('resend') 키를 쓴다. */}
                        {resendingId === invite.id ? t('orgInviteResending') : t('resend')}
                      </Button>
                      <Button size="sm" variant="glass" disabled={revokingId === invite.id} onClick={() => void handleRevokeInvite(invite.id)}
                        className="text-destructive hover:ring-1 hover:ring-inset hover:ring-destructive/60"
                        aria-label={t('orgInviteRowActionAriaLabel', { n: index + 1, label: revokingId === invite.id ? t('orgInviteCancelling') : tc('cancel') })}
                      >
                        {/* story #3608+#3606 병합 — 낱말("취소 중…")+기본 라벨은
                            #3606이 쓰는 공용 tc('cancel') 키. */}
                        {revokingId === invite.id ? t('orgInviteCancelling') : tc('cancel')}
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            ))}
            </div>
          </SectionCardBody>
        </SectionCard>
      )}
    </div>
  );
}
