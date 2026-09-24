'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';

export interface OrgSummaryRow {
  member_id: string;
  role_key: string;
  role_label: string | null;
  hit_rate: number | null;
  resolved: number | null;
  computed_at: string;
  // story #3749(신뢰 센터 재설계) — 콜드스타트(resolved=0) 행의 부제가 "판정 대기
  // 가설 N건" 문장을 내려면 필요. BE가 이미 metrics JSONB에 갖고 있던 값을 이
  // 스토리에서 org-summary 응답에 배선(routers/trust_scores.py 1줄).
  pending: number | null;
  // story #4285 — 이름 · 종류를 서버가 조직 범위로 싣는다(다른 프로젝트 에이전트도). 지워진(또는 이 조직에서 못 찾는) 구성원이면
  // name=null · member_deleted=true. 옛 서버 응답엔 없을 수 있어 선택 필드.
  name?: string | null;
  member_type?: 'human' | 'agent' | null;
  member_deleted?: boolean;
}

export interface HistorySnapshot {
  computed_at: string;
  hit_rate: number | null;
  resolved: number | null;
}

export interface SelfScore {
  role_key: string;
  role_label: string | null;
  hit_rate: number | null;
  resolved: number | null;
  // story #3749 — GET /trust-scores(자기 조회)는 compute_member_trust_scores()의
  // score dict를 그대로 낸다 — pending은 이미 응답에 있었다(BE 무변경, FE 타입만 보강).
  pending: number | null;
}

export interface RosterMember {
  id: string;
  name: string;
  email?: string;
  /** [SID:4282] 조직 역할(owner/admin/member) — /api/org-members에만 있다(같은 이름 구분 꼬리용). */
  role?: string;
}

export type Translator = (key: string, values?: Record<string, string | number>) => string;

// story 7e21a8b5(C2a-FE): 콜드스타트(표본 없음) 판정 — hit_rate=0(나쁜 성과)과 표본 자체가
// 없는 상태를 반드시 구분한다(E-VERIFY: 0%처럼 안 보이게).
export function isColdStart(hitRate: number | null, resolved: number | null): boolean {
  return hitRate === null || resolved === null || resolved === 0;
}

// story #3749(유나 定, 2026-09-09) — 콜드스타트 행 부제 두 갈래. 「3건 더」류 계약에
// 없는 수는 짓지 않는다 — resolved===0∧pending>0이면 그 수만, pending===0이면 수
// 자체를 안 쓴다("아직 판정한 가설이 없습니다"). 값은 호출부(page.tsx)가 `t()`로
// 채운다 — 이 함수는 키 이름과 보간값만 돌려준다(순수 함수, i18n 훅 없음).
export function coldStartReason(pending: number | null): { key: string; values?: { n: number } } {
  if (pending !== null && pending > 0) {
    return { key: 'trustColdStartPendingReason', values: { n: pending } };
  }
  return { key: 'trustColdStartEmptyReason' };
}

// story #3735(D1, 유나 定 2026-09-10) — role_label은 DB값(organization.py
// DEFAULT_PARTICIPATION_ROLES 시드, 조직 생성 시 1회 한글 고정 기록 — locale 무관·"구현"이
// 그 예)이라 i18n이 아니다. DB는 무변(적기만) — 기본 5키(무엇이 "기본"인지는 role_key로만
// 판정 가능·label 문자열로는 커스텀과 구분 불가)면 이 자리에서 i18n 정본으로 한 단계
// 앞질러 대체하고, 그 5키가 아니면(=조직이 직접 만든 커스텀 역할) DB의 role_label을 그대로
// 쓴다(커스텀이 이긴다 — 조직이 지은 이름을 FE가 덮어쓸 권한이 없다).
const DEFAULT_ROLE_LABEL_KEY: Record<string, string> = {
  implementation: 'trustRoleLabelImplementation',
  po: 'trustRoleLabelPo',
  qa: 'trustRoleLabelQa',
  design: 'trustRoleLabelDesign',
  devops: 'trustRoleLabelDevops',
};

export function resolveRoleLabel(roleKey: string, roleLabel: string | null, t: Translator): string {
  // story #3735 CHANGES(카디르 QA 지적) — 객체 리터럴 인덱싱은 role_key가
  // 'constructor'/'toString' 같은 Object.prototype 이름이면 상속받은 함수가
  // truthy로 걸려 커스텀 DB label 대신 그 함수 객체가 t()에 들어간다("커스텀이
  // 이긴다" 계약 위반). Object.hasOwn으로 이 자리의 실 프로퍼티인지부터 확認한다.
  const i18nKey = Object.hasOwn(DEFAULT_ROLE_LABEL_KEY, roleKey) ? DEFAULT_ROLE_LABEL_KEY[roleKey] : undefined;
  if (i18nKey) return t(i18nKey);
  return roleLabel ?? roleKey;
}

// 직무(role_key)별 그룹핑 — 순위/성과순 정렬 금지, role_label 이름순만(E-VERIFY 중립 정렬 규율).
export function groupRosterByRole(rows: OrgSummaryRow[], t: Translator): Array<[string, OrgSummaryRow[]]> {
  const groups = new Map<string, OrgSummaryRow[]>();
  for (const row of rows) {
    const key = resolveRoleLabel(row.role_key, row.role_label, t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// 유나 가디언 리뷰(PR#2191) 지적: groupRosterByRole은 그룹 자체는 이름순이지만, 그룹 시점엔
// 멤버 이름이 아직 미해소라 그룹 "내부" 멤버 순서는 BE org-summary 응답 순서 그대로 남는다 —
// BE가 성과(hit_rate)순으로 반환하면 그룹 안에서 줄세우기로 읽힐 수 있다(E-VERIFY 위반).
// BE 응답 순서를 신뢰하지 않고 FE에서 명시적으로 이름 기준 중립 재정렬한다 — 이름 미해소
// 멤버(lookup 미스)는 뒤로 밀되 member_id로 결정적 tie-break(리렌더마다 순서 흔들림 방지).
export function sortGroupMembersByName(rows: OrgSummaryRow[], lookup: Map<string, RosterMember>): OrgSummaryRow[] {
  return [...rows].sort((a, b) => {
    const nameA = lookup.get(a.member_id)?.name;
    const nameB = lookup.get(b.member_id)?.name;
    if (nameA && nameB) {
      // [SID:4282 · 까디르 P2] 이름이 같으면(«송윤재» 두 계정) 비교기가 0이라 BE 응답 순서(ORDER BY 없음)를 따라가
      // 새로고침마다 두 줄 순서가 바뀔 수 있었다 → member_id(같은 사람의 직무 두 행이면 role_key)로 끊는다.
      const byName = nameA.localeCompare(nameB);
      if (byName !== 0) return byName;
    } else if (nameA) return -1;
    else if (nameB) return 1;
    return a.member_id.localeCompare(b.member_id) || a.role_key.localeCompare(b.role_key);
  });
}

// org-members(OrgMember id 공간)+team-members(TeamMember id 공간) 두 소스를 병합 — org-summary의
// member_id는 legacy 시절 team_member.id를 canonicalize 안 한 채 저장된 경우가 있어(BE
// member_resolver.py canonicalize_member_id 패턴) 어느 쪽 id 공간이든 이름 해소가 가능해야 한다.
// org-members가 우선(조직 SSOT) — team-members는 org-members에서 못 찾은 것만 보강.
export function mergeMemberLookup(
  orgMembers: Array<{ id: string; name?: string | null; email?: string | null; role?: string | null }>,
  teamMembers: Array<{ id: string; name?: string | null }>,
): Map<string, RosterMember> {
  const lookup = new Map<string, RosterMember>();
  for (const m of orgMembers) {
    // story #4285(까디르 P2 ×2) — 리터럴 '?'도 이메일 앞부분도 이름으로 만들지 않는다(#3755 «이메일 폴백 0» — BE는 같은 행에 name null).
    // 이메일은 같은 이름 구분 꼬리 재료라 항목은 남기되 이름은 빈 채로. 표시 이름은 rosterDisplayName이 정한다.
    const name = m.name?.trim() || '';
    if (name || m.email) lookup.set(m.id, { id: m.id, name, email: m.email ?? undefined, role: m.role ?? undefined });
  }
  for (const m of teamMembers) {
    const name = m.name?.trim();
    if (name && !lookup.has(m.id)) lookup.set(m.id, { id: m.id, name });
  }
  return lookup;
}

// [SID:4282 · 유나 결정 2026-09-25] 같은 이름이 서로 다른 구성원(member_id)에게 붙으면 행만 보고는 못 가른다(배포 27
// 기기 탐색 점검 14번 — 소유자 · 관리자 두 계정이 같은 이름). 이름이 겹친 행에만 꼬리를 붙인다:
//   ① 겹친 무리 안에서 이 사람의 조직 역할이 유일하면 역할 라벨(«송윤재 · 소유자»)
//   ② 아니면(역할이 같거나 모름) 이메일 전체(관리자 전용 화면)
//   ③ 이메일도 없으면(team-members에서만 해소) ID 앞 8자
// 같은 사람이 직무 둘로 두 행이면 member_id가 같아 꼬리를 안 붙인다(부제의 직무가 이미 가른다). 반환 = member_id → 보일 이름.
export function disambiguatedNames(
  memberIds: string[],
  nameOf: (memberId: string) => string,
  lookup: Map<string, RosterMember>,
  roleLabel: (role: string) => string | null,
): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const id of new Set(memberIds)) {
    const n = nameOf(id);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n)!.push(id);
  }
  const out = new Map<string, string>();
  for (const [name, ids] of byName) {
    if (ids.length < 2) { out.set(ids[0], name); continue; }
    const roles = ids.map((id) => lookup.get(id)?.role ?? null);
    ids.forEach((id, i) => {
      const role = roles[i];
      const roleUnique = !!role && roles.filter((r) => r === role).length === 1;
      const roleText = roleUnique ? roleLabel(role as string) : null;
      const email = lookup.get(id)?.email;
      const tail = roleText ?? (email || id.slice(0, 8));
      out.set(id, `${name} · ${tail}`);
    });
  }
  return out;
}

// story 7e21a8b5(C2a-FE): E-VERIFY 톤 가드레일 — 순위/등급 컬러코딩 금지, chip(중립)만 사용.
// hit_rate=null(콜드스타트)은 0%와 시각적으로 구분되는 "데이터 부족" 표기로 대체.
export function TrustBadge({ hitRate, resolved, t }: { hitRate: number | null; resolved: number | null; t: Translator }) {
  if (isColdStart(hitRate, resolved) || hitRate === null) {
    return <Badge variant="chip">{t('trustColdStart')}</Badge>;
  }
  return <Badge variant="chip">{t('trustHitRate', { rate: Math.round(hitRate * 100) })}</Badge>;
}

// story #3749(유나 定 — "적중 막대") — Sparkline과 같은 E-VERIFY 톤 규율: 단일 중립색
// (등급/순위 컬러코딩 0). 시각 보조일 뿐 값은 옆 "적중 {rate}%" 텍스트가 SSOT.
export function HitRateBar({ hitRate }: { hitRate: number }) {
  const pct = Math.round(hitRate * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full rounded-full bg-muted-foreground" style={{ width: `${pct}%` }} />
    </div>
  );
}

// Ortega 지시(C2a 심화): history 드릴다운을 스파크라인으로 보강 — "성과 추이 그래프/감시"가
// 아니라 이미 리스트로 노출 중인 데이터의 가독성 개선일 뿐이므로, 신규 데이터/신규 신호를
// 만들지 않는다(숫자는 여전히 리스트가 SSOT). 콜드스타트(hit_rate=null) 지점은 값이 없어
// 그릴 수 없으므로 제외(0으로 대체하면 "나쁜 성과"로 왜곡 — isColdStart와 동일 원칙).
// BE history는 computed_at DESC(최신 우선)로 오므로 좌→우 시간순으로 보이도록 뒤집는다.
export function extractSparklineValues(snapshots: HistorySnapshot[]): number[] {
  return [...snapshots].reverse()
    .filter((s) => !isColdStart(s.hit_rate, s.resolved))
    .map((s) => s.hit_rate as number);
}

// 유나 가디언 리뷰(PR#2194) 지적: 상대 min-max 정규화는 미세변동(0.80→0.81→0.79)을 height
// 가득 채워 극적 지그재그로 과장 렌더해 "성과 추이 그래프/감시"로 오독시킨다(오르테가군 명시
// 요구와 직결). hit_rate는 원래 0-1로 유계이므로 **고정 스케일**을 쓴다 — 미세변동은 작게,
// 상수값은 그 실제 높이에 평평하게(range=0일 때 바닥으로 왜곡되던 문제도 해소).
export function sparklinePoints(values: number[], width = 120, height = 24, pad = 2): string {
  return values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (width - pad * 2);
      const y = height - pad - v * (height - pad * 2);
      return `${x},${y}`;
    })
    .join(' ');
}

// 순수 SVG 폴리라인 — 신규 차트 라이브러리 의존성 도입 안 함(과확대 방지·코드베이스에 선례
// 없음을 그라운딩으로 확認). E-VERIFY 톤: 단일 중립색(text-muted-foreground)만, red/yellow/green
// 등급 컬러 없음·축/라벨/숫자 없음(수치는 옆 리스트가 SSOT, 스파크라인은 형태만 보조).
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  return (
    <svg width={120} height={24} viewBox="0 0 120 24" className="text-muted-foreground" aria-hidden="true">
      <polyline points={sparklinePoints(values)} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// story #3749 CHANGES(페드루 PO, 유나 픽셀 캡처 지적 2026-09-09 17:23Z) — 펼침(스파크
// 라인+이력)이 행의 action 칸 «안»에 구겨져 있었다(캡처 실측) — 집안 `ListRow` 펼침
// 슬롯 관례(③ 채널 연결 앱 자격 폼 = 행 아래 전폭, list-row.tsx의 `children`)를
// 어긴 자리다. 트리거 버튼(행 다음 발 자리)과 펼침 패널(행 아래 전폭 자리)이 서로
// 다른 DOM 위치(`ListRow`의 `action` prop vs `children`)로 가야 해서, 상태를 한
// 컴포넌트 안에 가두던 원래 구조를 훅+트리거+패널 셋으로 쪼갠다(로직 자체는 무변경
// — 토글 함수·지연 조회·데이터 모양 그대로, 렌더 위치만 갈린다).
export function useHistoryDrilldown({ memberId, roleKey }: { memberId: string; roleKey: string }) {
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<HistorySnapshot[] | null>(null);

  const toggle = async () => {
    if (!open && snapshots === null) {
      const res = await fetch(`/api/trust-scores/history?member_id=${memberId}&role=${encodeURIComponent(roleKey)}`).catch(() => null);
      if (res?.ok) {
        const json = await res.json() as { snapshots?: HistorySnapshot[] };
        setSnapshots(json.snapshots ?? []);
      } else {
        setSnapshots([]);
      }
    }
    setOpen((v) => !v);
  };

  return { open, snapshots, toggle };
}

// 「추이 보기」 트리거 — `ListRow`의 `action` 자리(행 다음 발 관례, #4090/#4093과
// 동형 — variant="outline" size="sm"). §22-18(유나의 자) — 행마다 같은 정적
// 라벨이라 aria-label에 순번+현재 라벨을 품긴다(archiveRowAriaLabel과 동형 관례).
export function HistoryDrilldownTrigger({
  open, toggle, index, t,
}: { open: boolean; toggle: () => void; index: number; t: Translator }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void toggle()}
      data-testid="trust-history-toggle"
      aria-label={t('trustHistoryToggleAriaLabel', { n: index + 1, label: t('trustHistoryToggle') })}
    >
      {t('trustHistoryToggle')}
      {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
    </Button>
  );
}

// 펼침 패널 — `ListRow`의 `children` 자리(행 아래 전폭, ③ 앱 자격 폼과 동형 슬롯).
export function HistoryDrilldownPanel({
  open, snapshots, t,
}: { open: boolean; snapshots: HistorySnapshot[] | null; t: Translator }) {
  const displayTimezone = resolveDisplayTimezone().tz;
  if (!open) return null;
  return (
    <div className="mt-2 space-y-1" data-testid="trust-history-panel">
      {snapshots === null ? (
        <div className="h-8 animate-pulse rounded-md bg-muted" />
      ) : snapshots.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('trustHistoryEmpty')}</p>
      ) : (
        <>
          <Sparkline values={extractSparklineValues(snapshots)} />
          {/* story #3749 CHANGES(페드루 PO, 유나 픽셀 캡처 e7410279 지적 2026-09-09
              17:48Z) — 이력 행 시각이 `formatRelativeTime`이면 한 열에 "2분 전·
              어제·5일 전·08-31 02:38 GMT+9"가 섞인다(#4093 「발행」 칸에서 이미
              닫은 같은 클래스 — 7일이 지나면 절대 표기로 넘어가는 그 함수 자신의
              분기 때문에 한 열 안에서 상대·절대가 섞인다). 定②(행 부제 "…기준")와
              같은 §11-2 정본 절대 포맷으로 통일 — 한 화면 안에 두 표기 규율을
              안 둔다. */}
          {snapshots.map((s) => (
            <div key={s.computed_at} className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{formatScheduledAt(s.computed_at, displayTimezone).display}</span>
              <TrustBadge hitRate={s.hit_rate} resolved={s.resolved} t={t} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// story #4285 — 이름은 org-summary 응답이 정본이다(조직 범위 조인). 예전엔 조직 구성원(사람) + 지금 프로젝트 팀원 두 부분 목록으로만
// 짜 맞춰 같은 조직 다른 프로젝트의 에이전트가 «알 수 없는 구성원»이었다. 응답 이름이 있으면 그 이름으로 덮고(이메일 · 역할은 그대로 —
// 같은 이름 구분 꼬리 재료), 없으면(옛 서버 · 지워진 구성원) 기존 조회값 그대로. 지워진 구성원은 조회에 없으니 화면 폴백
// «알 수 없는 구성원»은 그 경우에만 남는다.
export function withSummaryNames(lookup: Map<string, RosterMember>, rows: OrgSummaryRow[]): Map<string, RosterMember> {
  const out = new Map(lookup);
  for (const row of rows) {
    const name = row.name?.trim();
    if (!name) continue;
    const prev = out.get(row.member_id);
    out.set(row.member_id, { ...(prev ?? { id: row.member_id }), name });
  }
  return out;
}

// story #4285(까디르 P2 · PO 처방 ×2) — 신뢰 센터 행 이름을 한 곳에서 정한다. 제목 · 이니셜 · 정렬이 모두 이 판정을 읽는다.
// 새 서버(요약 행에 member_deleted가 있음)면 **요약 이름만** — 조회 이름(조직 구성원 · 팀원 목록)은 보지 않는다(BE가 이메일 폴백 없이
// null을 준 행에 화면이 이메일 앞부분을 내던 부딪힘 · #3755). 옛 서버(플래그 없음)만 조회 이름으로 폴백.
export function rosterRealName(row: OrgSummaryRow, lookup: Map<string, RosterMember>): string | null {
  if (row.member_deleted !== undefined) return row.member_deleted ? null : (row.name?.trim() || null);
  return lookup.get(row.member_id)?.name?.trim() || null;
}

// 이름이 없을 때의 낱말: 지워진 구성원 → «알 수 없는 구성원» · 살아 있는데 이름이 빈 구성원(에이전트 PATCH가 name null을 받는다 ·
// 사람의 이름 · display_name이 둘 다 빔) → «이름 없는 구성원» · 옛 서버에서 못 찾음 → «알 수 없는 구성원». 날것 `?` · 이메일 0.
export function rosterDisplayName(
  row: OrgSummaryRow,
  lookup: Map<string, RosterMember>,
  labels: { unknown: string; unnamed: string },
): string {
  return rosterRealName(row, lookup) ?? (row.member_deleted === false ? labels.unnamed : labels.unknown);
}

/** 정렬용 조회 — 진짜 이름만 싣는다(«이름 없는 구성원» 같은 대체 낱말은 이름이 아니라 이름 있는 행 뒤로 간다). */
export function rosterSortLookup(rows: OrgSummaryRow[], lookup: Map<string, RosterMember>): Map<string, RosterMember> {
  const out = new Map<string, RosterMember>();
  for (const row of rows) {
    const name = rosterRealName(row, lookup);
    if (name) out.set(row.member_id, { id: row.member_id, name });
  }
  return out;
}
