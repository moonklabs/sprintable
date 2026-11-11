'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, ChevronDown, Copy } from 'lucide-react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { CountBadge } from '@/components/ds/count-badge';
import { Input } from '@/components/ds/input';
import { NativeSelect } from '@/components/ds/select';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { RemoveOrgMemberDialog } from '@/components/settings/remove-org-member-dialog';
import { SettingsSection } from './settings-section';
import { Tag } from './settings-parts';
import { cn } from '@/lib/utils';
import { useRenderNonce } from '@/hooks/use-render-nonce';

import { fetchWithAuth } from '@/lib/db/client';
import { fetchMe } from '@/lib/me-client';
import { canEditOrgMemberRole, orgRoleLabel } from '@/lib/org-member-role';
import { memberDisplayLabel } from '@/lib/member-display';
import { copyTextSafely } from '@/lib/clipboard';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { formatViewerScheduledAt } from '@/lib/schedule-format';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

interface OrgMember {
  id: string;
  user_id: string | null;
  name: string | null;
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
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)

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
  // story #3986 CHANGES(페드루 PO C2) — 초대 목록 행은 invite_url 자체를 화면에
  // 안 그린다(버튼 title에만 있음). 실패했을 때만 선택 가능하게 노출한다.
  const [copyFailedInviteUrl, setCopyFailedInviteUrl] = useState<string | null>(null);

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
      fetchMe().catch(() => null),
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
        // [SID:4286] 이름 칸 폴백 — 이메일 앞부분 · user_id 조각 · 날것 «?»를 이름으로 지어내지 않는다(선생님 상수
        // «이메일은 이름 칸에 안 싣는다» · 3755번 AC1). 이름이 없으면 null 그대로 두고 그릴 때 memberDisplayLabel로.
        name: m.name?.trim() || null,
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
      <SkeletonGroup label={tc('loading')} className="space-y-3">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}
      </SkeletonGroup>
    );
  }

  if (!canManage) {
    return (
      <Card className="space-y-1 p-3">
        <p className="text-ds-body font-medium text-ds-ink">{t('orgMembersAdminOnly')}</p>
        <p className="text-ds-body text-ds-ink-3">{t('orgMembersAdminOnlyHint')}</p>
      </Card>
    );
  }

  // story #3986(클래스 «거짓 성공 표시») — 이 자리는 이미 성공/실패를 가르고
  // 있었다(회귀 대상은 아님), 공용 헬퍼로 일반화만(발명 0) + 낱말 정본 통일
  // (유나 지시 2026-09-17 02:47Z — orgMemberClipboardCopyFailed 걷음).
  const handleCopyInviteLink = async (inviteId: string, url: string | undefined) => {
    if (!url) return;
    const result = await copyTextSafely(url);
    if (!result.ok) {
      bumpActionMessageNonce();
      setActionMessage({ type: 'error', text: tc('copyFailedSelectManually') });
      setCopyFailedInviteUrl(url);
      return;
    }
    setCopyFailedInviteUrl(null);
    setCopiedInviteId(inviteId);
    setTimeout(() => setCopiedInviteId(null), 1500);
  };

  // one flat row of a list: the name (and what goes under it) on the left, the row's actions on the right; wraps under the name on a narrow screen
  const rowClass = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5';
  const listClass = 'divide-y divide-ds-line overflow-hidden rounded-ds-control border border-ds-line';

  return (
    <div className="space-y-6">
      {/* 초대 폼 */}
      {canManage && (
        <SettingsSection title={t('orgMembersHeading')} description={t('orgMembersInviteDescription')}>
          <div className="flex flex-col gap-3 md:flex-row">
            <Input
              type="email"
              className="min-w-0 md:flex-1"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="email@example.com"
              aria-label={t('profileEmail')}
            />
            <NativeSelect
              className="md:w-40"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
              aria-label={t('agentRoleLabel')}
            >
              <option value="member">{t('roleMember')}</option>
              <option value="admin">{t('roleAdmin')}</option>
            </NativeSelect>
            <Button variant="primary" size="lg" onClick={() => void handleInvite()} disabled={!inviteEmail.trim() || inviting}>
              {inviting ? '...' : t('invite')}
            </Button>
          </div>

          {/* 정책B(05fa365f): 프로젝트 멀티선택 — 0개=미지정(조직만) */}
          <div className="space-y-2">
            <p className="text-ds-small font-semibold text-ds-ink">{t('inviteProjectsLabel')}</p>
            {orgProjects.length === 0 ? (
              <p className="text-ds-small text-ds-ink-3">{t('inviteProjectsEmpty')}</p>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowProjectPicker((v) => !v)}
                  aria-expanded={showProjectPicker}
                  className="w-full justify-between md:max-w-sm"
                >
                  <span className={inviteProjectIds.length === 0 ? 'text-ds-ink-3' : ''}>
                    {inviteProjectIds.length === 0
                      ? t('inviteProjectsTrigger')
                      : t('inviteProjectsCount', { count: inviteProjectIds.length })}
                  </span>
                  <ChevronDown className={`h-4 w-4 shrink-0 text-ds-ink-3 transition-transform ${showProjectPicker ? 'rotate-180' : ''}`} />
                </Button>
                {showProjectPicker && (
                  <ul className="max-h-56 space-y-1 overflow-y-auto rounded-ds-control border border-ds-line p-1 md:max-w-sm">
                    {orgProjects.map((p) => {
                      const selected = inviteProjectIds.includes(p.id);
                      return (
                        <li key={p.id}>
                          <Button
                            type="button"
                            variant="quiet"
                            onClick={() => toggleInviteProject(p.id)}
                            aria-pressed={selected}
                            className={cn('w-full justify-start', selected && 'bg-ds-action-soft text-ds-action-text')}
                          >
                            <span className="flex-1 truncate text-left">{p.name}</span>
                            {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
            <p className="text-ds-small text-ds-ink-3">{t('inviteProjectsHelper')}</p>
          </div>

          {inviteResult && (
            // story #2105 2차 — handleInvite가 재시도 전 setInviteResult(null)을 먼저 호출해(위
            // 정의) 매 시도마다 언마운트→리마운트된다. 에러=alert, 성공=status(ds Banner의 역할 규칙).
            <Banner tone={inviteResult.type === 'success' ? 'info' : 'failed'} className="break-all">{inviteResult.text}</Banner>
          )}
        </SettingsSection>
      )}

      {actionMessage && (
        <Banner key={actionMessageNonce} tone={actionMessage.type === 'success' ? 'info' : 'failed'}>{actionMessage.text}</Banner>
      )}
      {copyFailedInviteUrl && (
        <Input
          readOnly
          value={copyFailedInviteUrl}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono"
          data-testid="org-members-copy-failed-raw-invite-url"
        />
      )}

      {/* 멤버 목록 */}
      <SettingsSection
        // story #3735(UI 점검 B·E절, 유나 定) — 수를 제목 문자열 안에 넣지 않는다.
        // 제목 고정 + 수는 옆 CountBadge로(이벤트 화면 events/page.tsx와 동형).
        title={<span className="flex items-center gap-2">{t('orgMembersListHeading')}<CountBadge count={members.length} /></span>}
      >
        {members.length > 0 ? (
          <div className={listClass}>
            {/* story #3592(§17-20 ⑧·§22-18 동형) — 행마다 같은 「제거」 접근 이름이라
                보조기술 버튼 목록에서 어느 멤버 행인지 못 가른다. story #3606(잔여,
                페드루 PO 確定 2026-09-07)에서 이 파일 전체 하드코딩 한글을 마저
                i18n 키화했다(기존 키 재사용 우선, 새 낱말은 「문자열→키」 표 PR
                본문 참고). */}
            {members.map((member, index) => {
              const isThisOwner = member.role === 'owner';
              const canEdit = canEditOrgMemberRole({ currentRole, currentUserId, member });
              const label = memberDisplayLabel(member.name, tc);
              return (
                <div key={member.id} className={rowClass}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ds-body font-medium text-ds-ink">{label}</div>
                    {member.email ? <div className="truncate text-ds-small text-ds-ink-3">{member.email}</div> : null}
                    {member.joined_at ? <div className="mt-0.5 text-ds-small text-ds-ink-3">{t('orgMemberJoinedMeta', { time: formatViewerRelativeTime(member.joined_at, locale, displayTimezone) })}</div> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* story #3771(PO 별건 ㉓·유나 r65) — 역할 열/액션 열을 항상 둘 다 렌더한다
                        (행마다 열의 뜻이 같게). 역할 변경 불가 행(소유자·자기 자신)은 select 대신
                        배지가 서지만, 그 배지가 «제거» 버튼이 있던 자리로 밀려 앉으면 세로로 읽을
                        때 상태 딱지와 행동 버튼이 한 열에 섞인다(라이브 캡처로 실측된 결함) — 액션
                        열은 canEdit=false일 때도 같은 Button(같은 텍스트·크기, 그래서 폭이 로케일과
                        무관하게 정확히 같다)을 invisible로 그려 자리만 지킨다(클릭 불가·
                        aria-hidden — 보조기술 목록엔 아예 안 나온다). */}
                    {canEdit ? (
                      <NativeSelect
                        className="w-28"
                        value={member.role}
                        disabled={changingRoleId === member.id}
                        onChange={(e) => void handleChangeRole(member.id, e.target.value as 'admin' | 'member')}
                        aria-label={member.email ? `${label} (${member.email})` : label}
                      >
                        <option value="admin">{t('roleAdmin')}</option>
                        <option value="member">{t('roleMember')}</option>
                      </NativeSelect>
                    ) : (
                      <Tag tone={isThisOwner ? 'action' : 'neutral'}>{orgRoleLabel(member.role, t)}</Tag>
                    )}
                    {canEdit ? (
                      <Button
                        variant="secondary" onClick={() => setRemoveDialogMemberId(member.id)}
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
                        variant="secondary" tabIndex={-1} aria-hidden="true"
                        className="invisible pointer-events-none"
                        aria-label={t('orgMemberRowActionAriaLabel', { n: index + 1, label: t('removeFromProject') })}
                      >
                        {t('removeFromProject')}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-ds-body text-ds-ink-3">{t('orgMembersEmpty')}</p>
        )}
      </SettingsSection>

      {removeDialogMemberId ? (() => {
        const target = members.find((m) => m.id === removeDialogMemberId);
        if (!target) return null;
        return (
          <RemoveOrgMemberDialog
            open
            member={{ id: target.id, name: memberDisplayLabel(target.name, tc), email: target.email }}
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
        <SettingsSection
          // story #3735 CHANGES(유나 재검토) — orgMembersListHeading만 새 형으로
          // 옮기고 이 옆 헤더는 옛 괄호 형으로 남겨 같은 화면 안 두 형이 세로로 나란히
          // 서는 불일치를 만들었다. 같은 처방으로 통일.
          title={<span className="flex items-center gap-2">{t('orgInvitesListHeading')}<CountBadge count={invites.length} /></span>}
        >
          <div className={listClass}>
            {/* story #3592(§17-20 ⑧·§22-18 동형)·story #3606(잔여, 페드루 PO 確定
                2026-09-07) — 링크 복사·재발송·취소 aria-label은 기존
                orgInviteRowActionAriaLabel 유지, 하드코딩 한글은 마저 키화(기존
                키(share.copyLink·settings.resend·common.cancel) 재사용 우선). */}
            {invites.map((invite, index) => (
              <div key={invite.id} className={rowClass}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ds-body text-ds-ink">{invite.email}</div>
                  <div className="mt-0.5 text-ds-small text-ds-ink-3">{t('orgInviteMeta', { role: invite.role, date: formatViewerScheduledAt(invite.expires_at, displayTimezone).display })}</div>
                </div>
                {canManage ? (
                  <div className="flex shrink-0 flex-wrap gap-1">
                    <Button
                      variant="secondary"
                      disabled={!invite.invite_url}
                      onClick={() => void handleCopyInviteLink(invite.id, invite.invite_url)}
                      title={invite.invite_url ? t('orgInviteCopyLinkTitle') : t('orgInviteCopyLinkUnavailableTitle')}
                      className={copiedInviteId === invite.id ? 'border-ds-done bg-ds-done-soft' : ''}
                      aria-label={t('orgInviteRowActionAriaLabel', {
                        n: index + 1, label: copiedInviteId === invite.id ? t('orgInviteCopiedLabel') : tShare('copyLink'),
                      })}
                    >
                      {copiedInviteId === invite.id ? (
                        <><Check className="mr-1 h-3 w-3" />{t('orgInviteCopiedLabel')}</>
                      ) : (
                        <><Copy className="mr-1 h-3 w-3" />{tShare('copyLink')}</>
                      )}
                    </Button>
                    <Button
                      variant="secondary" disabled={resendingId === invite.id} onClick={() => void handleResendInvite(invite.id)}
                      aria-label={t('orgInviteRowActionAriaLabel', { n: index + 1, label: resendingId === invite.id ? t('orgInviteResending') : t('resend') })}
                    >
                      {/* story #3608(유나 §22-18 ④-2)+#3606(i18n화) 병합 — pending
                          "..."는 아무 말도 안 한다(낱말 "재발송 중…"로), 기본 라벨은
                          #3606이 새로 i18n화한 t('resend') 키를 쓴다. */}
                      {resendingId === invite.id ? t('orgInviteResending') : t('resend')}
                    </Button>
                    <Button variant="danger" disabled={revokingId === invite.id} onClick={() => void handleRevokeInvite(invite.id)}
                      aria-label={t('orgInviteRowActionAriaLabel', { n: index + 1, label: revokingId === invite.id ? t('orgInviteCancelling') : tc('cancel') })}
                    >
                      {/* story #3608+#3606 병합 — 낱말("취소 중…")+기본 라벨은
                          #3606이 쓰는 공용 tc('cancel') 키. */}
                      {revokingId === invite.id ? t('orgInviteCancelling') : tc('cancel')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </SettingsSection>
      )}
    </div>
  );
}
