'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export interface OrgSummaryRow {
  member_id: string;
  role_key: string;
  role_label: string | null;
  hit_rate: number | null;
  resolved: number | null;
  computed_at: string;
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
}

export interface RosterMember {
  id: string;
  name: string;
  email?: string;
}

export type Translator = (key: string, values?: Record<string, string | number>) => string;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

// story 7e21a8b5(C2a-FE): 콜드스타트(표본 없음) 판정 — hit_rate=0(나쁜 성과)과 표본 자체가
// 없는 상태를 반드시 구분한다(E-VERIFY: 0%처럼 안 보이게).
export function isColdStart(hitRate: number | null, resolved: number | null): boolean {
  return hitRate === null || resolved === null || resolved === 0;
}

// 직무(role_key)별 그룹핑 — 순위/성과순 정렬 금지, role_label 이름순만(E-VERIFY 중립 정렬 규율).
export function groupRosterByRole(rows: OrgSummaryRow[]): Array<[string, OrgSummaryRow[]]> {
  const groups = new Map<string, OrgSummaryRow[]>();
  for (const row of rows) {
    const key = row.role_label ?? row.role_key;
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
    if (nameA && nameB) return nameA.localeCompare(nameB);
    if (nameA) return -1;
    if (nameB) return 1;
    return a.member_id.localeCompare(b.member_id);
  });
}

// org-members(OrgMember id 공간)+team-members(TeamMember id 공간) 두 소스를 병합 — org-summary의
// member_id는 legacy 시절 team_member.id를 canonicalize 안 한 채 저장된 경우가 있어(BE
// member_resolver.py canonicalize_member_id 패턴) 어느 쪽 id 공간이든 이름 해소가 가능해야 한다.
// org-members가 우선(조직 SSOT) — team-members는 org-members에서 못 찾은 것만 보강.
export function mergeMemberLookup(
  orgMembers: Array<{ id: string; name?: string | null; email?: string | null }>,
  teamMembers: Array<{ id: string; name?: string | null }>,
): Map<string, RosterMember> {
  const lookup = new Map<string, RosterMember>();
  for (const m of orgMembers) {
    lookup.set(m.id, { id: m.id, name: (m.name?.trim() || null) ?? m.email?.split('@')[0] ?? '?', email: m.email ?? undefined });
  }
  for (const m of teamMembers) {
    if (!lookup.has(m.id)) lookup.set(m.id, { id: m.id, name: m.name?.trim() || '?' });
  }
  return lookup;
}

// story 7e21a8b5(C2a-FE): E-VERIFY 톤 가드레일 — 순위/등급 컬러코딩 금지, chip(중립)만 사용.
// hit_rate=null(콜드스타트)은 0%와 시각적으로 구분되는 "데이터 부족" 표기로 대체.
export function TrustBadge({ hitRate, resolved, t }: { hitRate: number | null; resolved: number | null; t: Translator }) {
  if (isColdStart(hitRate, resolved) || hitRate === null) {
    return <Badge variant="chip">{t('trustColdStart')}</Badge>;
  }
  return <Badge variant="chip">{t('trustHitRate', { rate: Math.round(hitRate * 100) })}</Badge>;
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
    <svg width={120} height={24} viewBox="0 0 120 24" className="text-muted-foreground/60" aria-hidden="true">
      <polyline points={sparklinePoints(values)} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HistoryDrilldown({ memberId, roleKey, t }: { memberId: string; roleKey: string; t: Translator }) {
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

  return (
    <div>
      <button
        type="button"
        onClick={() => void toggle()}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {t('trustHistoryToggle')}
        {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      </button>
      {open ? (
        <div className="mt-2 space-y-1">
          {snapshots === null ? (
            <div className="h-8 animate-pulse rounded-md bg-muted" />
          ) : snapshots.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('trustHistoryEmpty')}</p>
          ) : (
            <>
              <Sparkline values={extractSparklineValues(snapshots)} />
              {snapshots.map((s) => (
                <div key={s.computed_at} className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{formatDate(s.computed_at)}</span>
                  <TrustBadge hitRate={s.hit_rate} resolved={s.resolved} t={t} />
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
