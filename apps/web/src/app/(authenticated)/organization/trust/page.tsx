'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { HeartHandshake } from 'lucide-react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ListRow } from '@/components/ui/list-row';
import { PageHeader } from '@/components/ui/page-header';
import { resolveDisplayTimezone, formatScheduledAt } from '@/components/content/schedule-format';
import {
  coldStartReason,
  groupRosterByRole,
  isColdStart,
  mergeMemberLookup,
  resolveRoleLabel,
  sortGroupMembersByName,
  useHistoryDrilldown,
  HistoryDrilldownPanel,
  HistoryDrilldownTrigger,
  HitRateBar,
  TrustBadge,
  type OrgSummaryRow,
  type RosterMember,
  type SelfScore,
} from './trust-utils';
import { fetchWithAuth } from '@/lib/db/client';

// story #3749(재설계 ⑤, 시안 ④⑤ v3b 74290976) — 역할별 SectionCard 쪼개기를 걷고
// 역할 칩으로 좁히는 한 목록으로. admin 뷰만 칩을 갖는다(self 뷰는 이미 "내 역할"
// 소수라 좁힐 필요가 옅다 — 시안·카드 둘 다 self 뷰의 칩을 요구하지 않는다).
const ALL_ROLES = 'all' as const;

function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

// story #3749 CHANGES(유나 定, 2026-09-09 17:28Z) — 원래 `ListRowMark`(채널 목록·
// #3743용 30×30 색 «사각» 표식, 어두운 배경+흰 글자)를 그대로 재사용했으나 유나
// 픽셀 캡처 지적 — 사람 표식은 이 레포에 이미 두 선례가 있고(team-activity-view.tsx
// `ActorAvatar`·chat-list-view.tsx 참여자 표식) 둘 다 «연한 원+muted 글자색»이지
// 어두운 사각+흰 글자가 아니다. `ListRowMark`는 채널 색 구분(의미 있는 색상 코딩)이
// 용도라 그 자체를 바꾸면 채널 목록이 깨진다 — 이 화면 전용 표식을 따로 둔다(색
// 코딩 없음, 이 화면엔 애초에 "역할"이 색으로 갈릴 이유가 없다는 원 판단은 무변).
function PersonMark({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
    >
      {label}
    </span>
  );
}

export default function OrganizationTrustPage() {
  const { orgId, orgMemberships, currentTeamMemberId, projectId } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';
  const isAdmin = currentRole === 'owner' || currentRole === 'admin';
  const t = useTranslations('organization');
  const displayTimezone = resolveDisplayTimezone().tz;

  const [loading, setLoading] = useState(true);
  const [rosterRows, setRosterRows] = useState<OrgSummaryRow[]>([]);
  const [rosterMembers, setRosterMembers] = useState<Map<string, RosterMember>>(new Map());
  const [selfScores, setSelfScores] = useState<SelfScore[]>([]);
  // story #3749 — 역할 칩 좁히기(클라이언트, org-summary가 전량이라 정직하다 —
  // limit/offset/cursor 0 확認됨). 그룹 키는 groupRosterByRole과 동일(role_label ??
  // role_key) — 칩과 실제 필터가 같은 축을 쓴다(어긋나면 칩 수=거짓이 된다).
  const [roleFilter, setRoleFilter] = useState<string>(ALL_ROLES);

  useEffect(() => {
    let cancelled = false;
    async function loadAdmin() {
      const [summaryRes, orgMembersRes, teamMembersRes] = await Promise.all([
        fetchWithAuth('/api/trust-scores/org-summary').catch(() => null),
        fetchWithAuth('/api/org-members').catch(() => null),
        projectId ? fetchWithAuth(`/api/team-members?project_id=${projectId}`).catch(() => null) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const summaryJson = summaryRes?.ok ? await summaryRes.json() as { members?: OrgSummaryRow[] } : { members: [] };
      const orgMembersJson = orgMembersRes?.ok ? await orgMembersRes.json() as { data?: Array<{ id: string; name?: string | null; email?: string | null }> } : { data: [] };
      const teamMembersJson = teamMembersRes?.ok ? await teamMembersRes.json() as { data?: Array<{ id: string; name?: string | null }> } : { data: [] };
      if (cancelled) return;
      setRosterRows(summaryJson.members ?? []);
      setRosterMembers(mergeMemberLookup(orgMembersJson.data ?? [], teamMembersJson.data ?? []));
      setLoading(false);
    }
    async function loadSelf() {
      if (!currentTeamMemberId) { setLoading(false); return; }
      const res = await fetchWithAuth(`/api/trust-scores?member_id=${currentTeamMemberId}`).catch(() => null);
      if (cancelled) return;
      if (res?.ok) {
        const json = await res.json() as { scores?: SelfScore[] };
        setSelfScores(json.scores ?? []);
      }
      setLoading(false);
    }
    void (isAdmin ? loadAdmin() : loadSelf());
    return () => { cancelled = true; };
  }, [isAdmin, currentTeamMemberId, projectId]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-3 p-6">
        {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
      </div>
    );
  }

  // story #3749 — 정렬 = 이름순(기존 sortGroupMembersByName 재사용, 순위 0). 칩용
  // 그룹은 groupRosterByRole을 그대로 재사용(SectionCard로 안 그리고 칩 라벨+수만
  // 뽑는다) — 새 그룹 함수를 또 만들지 않는다.
  const groupedByRole = groupRosterByRole(rosterRows, t);
  const sortedRows = sortGroupMembersByName(rosterRows, rosterMembers);
  const visibleRows = roleFilter === ALL_ROLES
    ? sortedRows
    : sortedRows.filter((row) => resolveRoleLabel(row.role_key, row.role_label, t) === roleFilter);

  function renderAdminRow(row: OrgSummaryRow, index: number) {
    return (
      <AdminRow
        key={`${row.member_id}-${row.role_key}`}
        row={row}
        index={index}
        name={rosterMembers.get(row.member_id)?.name ?? t('trustUnknownMember')}
        t={t}
        displayTimezone={displayTimezone}
      />
    );
  }

  function renderSelfRow(score: SelfScore, index: number) {
    return (
      <SelfRow
        key={score.role_key}
        score={score}
        index={index}
        currentTeamMemberId={currentTeamMemberId}
        t={t}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      {/* story #3749(⓪ 화면 머리, page-header.tsx 개정 절) — PageHeader가 title+
          설명을 갖는다. 주 액션 0(읽는 화면 — 시안·계약 둘 다 컨트롤을 안 요구한다).
          title 키는 그대로 trustSlotTitle(verify-nav-label-matches-title PAIRINGS
          org-trust↔trustSlotTitle — 옮기며 키를 갈면 그 가드가 RED된다). */}
      <PageHeader title={t('trustSlotTitle')} description={t('trustPurposeFraming')} />

      {isAdmin ? (
        rosterRows.length === 0 ? (
          <EmptyState
            icon={<HeartHandshake className="size-8" />}
            title={t('trustEmptyTitle')}
            description={t('trustEmptyRoster')}
          />
        ) : (
          <>
            {/* story #3749 — 역할 칩(필터 하나뿐이라 맨 pill 허용, 유나 定 — 늘어나면
                라벨: 값 드롭다운으로). 「모든 역할」은 수 0(행 수=쌍 수라 사람 수로
                읽히면 거짓), 역할별 칩만 "{역할} {n}명"(행 키가 사람×역할 쌍이라
                참). */}
            <div className="flex flex-wrap items-center gap-2" data-testid="trust-role-filter">
              <Button
                type="button"
                variant={roleFilter === ALL_ROLES ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => setRoleFilter(ALL_ROLES)}
                data-testid="trust-role-filter-all"
              >
                {t('trustAllRolesFilter')}
              </Button>
              {groupedByRole.map(([roleLabel, rows]) => (
                <Button
                  key={roleLabel}
                  type="button"
                  variant={roleFilter === roleLabel ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={() => setRoleFilter(roleLabel)}
                  data-testid="trust-role-filter-role"
                  // §22-18(유나의 자) — 칩마다 눈에 보이는 라벨 자체가 이미 역할+수로
                  // 갈리지만(정적 텍스트 아님), 이 가드는 소스 정적 분석이라 그 사실을
                  // 못 본다. aria-label에 같은 값을 그대로 실어 통과(새 키 발명 없음
                  // — 보이는 라벨=접근성 이름, 중복이지만 무해).
                  aria-label={t('trustRoleFilter', { role: roleLabel, n: rows.length })}
                >
                  {t('trustRoleFilter', { role: roleLabel, n: rows.length })}
                </Button>
              ))}
            </div>
            {/* story #3785(유나 定) — 1층 규칙: Card(surface='solid'). */}
            <Card className="divide-y divide-border">
              {visibleRows.map(renderAdminRow)}
            </Card>
          </>
        )
      ) : selfScores.length === 0 ? (
        <EmptyState
          icon={<HeartHandshake className="size-8" />}
          title={t('trustEmptyTitle')}
        />
      ) : (
        <>
          <h2 className="text-base font-semibold text-foreground">{t('trustSelfTitle')}</h2>
          <Card className="divide-y divide-border">
            {selfScores.map(renderSelfRow)}
          </Card>
        </>
      )}

      {/* story #3749(定③) — 하단 참고 문장. 시안 둘째 문장(낮은 이유 추측)은 화면이
          모르는 것이라 안 옮긴다 — "평가가 아니다"는 헤더가 이미 말한다. */}
      {(isAdmin ? rosterRows.length > 0 : selfScores.length > 0) ? (
        <p className="text-xs text-muted-foreground" data-testid="trust-hit-rate-meaning">
          {t('trustHitRateMeaning')}
        </p>
      ) : null}
    </div>
  );
}

// story #3749 CHANGES(페드루 PO, 유나 픽셀 캡처 지적) — 펼침 패널이 `ListRow`의
// `children`(행 아래 전폭) 자리로 가려면 트리거·패널이 각자 다른 DOM 위치에서 같은
// 펼침 상태를 공유해야 한다 — 그 상태(useHistoryDrilldown)를 쥐는 자리가 이제 행
// 컴포넌트 자체다(훅은 컴포넌트 안에서만 부를 수 있다, .map() 콜백 안 직접 호출 불가).
function AdminRow({
  row, index, name, t, displayTimezone,
}: { row: OrgSummaryRow; index: number; name: string; t: ReturnType<typeof useTranslations>; displayTimezone: string }) {
  const roleLabel = resolveRoleLabel(row.role_key, row.role_label, t);
  const coldStart = isColdStart(row.hit_rate, row.resolved);
  const drilldown = useHistoryDrilldown({ memberId: row.member_id, roleKey: row.role_key });
  return (
    <ListRow
      data-testid="trust-roster-row"
      mark={<PersonMark label={initial(name)} />}
      title={name}
      subtitle={coldStart ? (
        <ColdStartSubtitle roleLabel={roleLabel} pending={row.pending} t={t} />
      ) : (
        t('trustRoleComputedAt', { role: roleLabel, time: formatScheduledAt(row.computed_at, displayTimezone).display })
      )}
      status={coldStart ? (
        <TrustBadge hitRate={row.hit_rate} resolved={row.resolved} t={t} />
      ) : (
        <HitRateCell hitRate={row.hit_rate as number} t={t} />
      )}
      action={<HistoryDrilldownTrigger open={drilldown.open} toggle={drilldown.toggle} index={index} t={t} />}
    >
      <HistoryDrilldownPanel open={drilldown.open} snapshots={drilldown.snapshots} t={t} />
    </ListRow>
  );
}

function SelfRow({
  score, index, currentTeamMemberId, t,
}: { score: SelfScore; index: number; currentTeamMemberId: string | null | undefined; t: ReturnType<typeof useTranslations> }) {
  const roleLabel = resolveRoleLabel(score.role_key, score.role_label, t);
  const coldStart = isColdStart(score.hit_rate, score.resolved);
  // story #3749(원 주석 그대로) — currentTeamMemberId가 없으면(이론상 self 뷰 진입
  // 자체가 team member 전제라 드묾) 펼침 훅에 넘길 memberId가 없다 — 훅은 항상 호출
  // 하되(rules-of-hooks) 빈 문자열로 fetch를 무해화하고 트리거 자체를 안 그린다.
  const drilldown = useHistoryDrilldown({ memberId: currentTeamMemberId ?? '', roleKey: score.role_key });
  return (
    <ListRow
      data-testid="trust-self-row"
      mark={<PersonMark label={initial(roleLabel)} />}
      title={roleLabel}
      // self 뷰는 title이 이미 role_label이라(누구인지가 아니라 어느 역할인지가
      // 축) 定②의 "{role} · {time} 기준"을 그대로 못 쓴다 — GET /trust-scores
      // (자기 조회) 응답엔 애초에 computed_at 자체가 없다(스코어만, 스냅샷 메타
      // 없음). 콜드스타트 사유 문장에도 role 접두를 안 붙인다(title에 이미 있어
      // 중복) — admin 행과 다른 자리(showRole=false).
      subtitle={coldStart ? <ColdStartSubtitle pending={score.pending} t={t} /> : null}
      status={coldStart ? (
        <TrustBadge hitRate={score.hit_rate} resolved={score.resolved} t={t} />
      ) : (
        <HitRateCell hitRate={score.hit_rate as number} t={t} />
      )}
      action={currentTeamMemberId ? <HistoryDrilldownTrigger open={drilldown.open} toggle={drilldown.toggle} index={index} t={t} /> : undefined}
    >
      {currentTeamMemberId ? <HistoryDrilldownPanel open={drilldown.open} snapshots={drilldown.snapshots} t={t} /> : null}
    </ListRow>
  );
}

// story #3749(유나 定②③) — 콜드스타트 행 부제. admin 행(roleLabel 있음)만 역할을
// 앞에 붙인다 — 「모든 역할」 미필터 뷰에서 한 사람이 역할을 둘 이상 가지면 부제가
// 없으면 어느 역할 행인지 안 갈린다(定②가 "{role} · {time} 기준"으로 지키는 것과
// 같은 이유, 여기선 시각 대신 사유 문장을 잇는다). self 행은 title이 이미 role_label
// 이라(roleLabel 생략) 중복 안 붙인다. "·"는 문구가 아니라 定②와 같은 구조적
// 구분자라 i18n 값이 아니라 여기서 조립.
function ColdStartSubtitle({ roleLabel, pending, t }: { roleLabel?: string; pending: number | null; t: ReturnType<typeof useTranslations> }) {
  const { key, values } = coldStartReason(pending);
  const reason = t(key, values);
  return roleLabel ? <>{roleLabel} · {reason}</> : <>{reason}</>;
}

// story #3749(定 — 「적중 {rate}%」 칸 nowrap·72px, 유나 렌더 실측: 56px면 두 줄로
// 접힘) — 막대+텍스트 조합, 값은 텍스트가 SSOT(막대는 시각 보조).
function HitRateCell({ hitRate, t }: { hitRate: number; t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="flex items-center gap-2">
      <HitRateBar hitRate={hitRate} />
      <span className="w-[72px] shrink-0 text-right text-xs whitespace-nowrap text-muted-foreground" data-testid="trust-hit-rate-text">
        {t('trustHitRate', { rate: Math.round(hitRate * 100) })}
      </span>
    </div>
  );
}
