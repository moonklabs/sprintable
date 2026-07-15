import { describe, expect, it } from 'vitest';
import { isColdStart, groupRosterByRole, mergeMemberLookup, sortGroupMembersByName, extractSparklineValues, sparklinePoints } from './trust-utils';
import type { RosterMember, HistorySnapshot } from './trust-utils';

describe('isColdStart (story 7e21a8b5 — E-VERIFY 콜드스타트 중립 판정)', () => {
  it('is cold-start when hit_rate is null (표본 없음)', () => {
    expect(isColdStart(null, 0)).toBe(true);
  });

  it('is cold-start when resolved is 0 even if hit_rate is somehow non-null (방어적)', () => {
    expect(isColdStart(0.5, 0)).toBe(true);
  });

  it('is NOT cold-start for a real 0% hit rate with resolved samples (0%와 콜드스타트는 다르다)', () => {
    expect(isColdStart(0, 3)).toBe(false);
  });

  it('is NOT cold-start for a normal resolved hit rate', () => {
    expect(isColdStart(0.82, 11)).toBe(false);
  });
});

describe('groupRosterByRole (E-VERIFY 중립 정렬 — 성과순 금지, 라벨 이름순만)', () => {
  const row = (member_id: string, role_key: string, role_label: string | null, hit_rate: number | null = null, resolved: number | null = 0) =>
    ({ member_id, role_key, role_label, hit_rate, resolved, computed_at: '2026-07-15T00:00:00Z' });

  it('groups rows by role_label, sorted alphabetically regardless of hit_rate (순위 금지 회귀가드)', () => {
    // QA의 hit_rate(0.1)가 개발(0.95)보다 훨씬 낮게 설계 — hit_rate 내림차순 정렬이었다면
    // '개발'이 먼저 와야 한다. 실제로는 로케일 문자열 비교('Q' < '개')로 'QA'가 먼저 온다 —
    // 성과순이 아니라 이름순임을 명확히 갈리는 픽스처로 증명(뮤테이션 셀프체크로 검증됨).
    const rows = [
      row('m1', 'qa', 'QA', 0.1, 10),
      row('m2', 'dev', '개발', 0.95, 10),
      row('m3', 'dev', '개발', 0.99, 10),
    ];
    const grouped = groupRosterByRole(rows);
    expect(grouped.map(([label]) => label)).toEqual(['QA', '개발']);
    expect(grouped.find(([label]) => label === '개발')?.[1]).toHaveLength(2);
  });

  it('falls back to role_key when role_label is null', () => {
    const grouped = groupRosterByRole([row('m1', 'dev', null)]);
    expect(grouped).toEqual([['dev', [row('m1', 'dev', null)]]]);
  });

  it('returns empty for an empty roster', () => {
    expect(groupRosterByRole([])).toEqual([]);
  });
});

describe('sortGroupMembersByName (유나 가디언 지적 PR#2191 — within-group 순위 누수 fix)', () => {
  const row = (member_id: string, hit_rate: number | null = null, resolved: number | null = 0) =>
    ({ member_id, role_key: 'dev', role_label: '개발', hit_rate, resolved, computed_at: '2026-07-15T00:00:00Z' });
  const lookup = (entries: Array<[string, string]>) =>
    new Map<string, RosterMember>(entries.map(([id, name]) => [id, { id, name }]));

  it('sorts by resolved name, ignoring hit_rate (BE org-summary는 ORDER BY 없음 — FE가 방어)', () => {
    // BE 응답 순서를 그대로 시뮬레이션: hit_rate 높은 순으로 옴(우연한 성과순 — 실제 BE엔
    // ORDER BY 자체가 없어 발생 가능한 상황). FE 재정렬 없이 그대로 쓰면 줄세우기로 읽힌다.
    const rows = [row('m-charlie', 0.99, 10), row('m-alice', 0.1, 10), row('m-bob', 0.5, 10)];
    const names = lookup([['m-charlie', 'Charlie'], ['m-alice', 'Alice'], ['m-bob', 'Bob']]);
    const sorted = sortGroupMembersByName(rows, names);
    expect(sorted.map((r) => r.member_id)).toEqual(['m-alice', 'm-bob', 'm-charlie']);
  });

  it('pushes unresolved (name-lookup miss) members to the end, not first', () => {
    const rows = [row('m-unknown'), row('m-alice')];
    const names = lookup([['m-alice', 'Alice']]);
    const sorted = sortGroupMembersByName(rows, names);
    expect(sorted.map((r) => r.member_id)).toEqual(['m-alice', 'm-unknown']);
  });

  it('tie-breaks by member_id when both are unresolved (결정론적 — 알 수 없는 구성원끼리 순서 안정)', () => {
    const rows = [row('m-zzz'), row('m-aaa')];
    const sorted = sortGroupMembersByName(rows, new Map());
    expect(sorted.map((r) => r.member_id)).toEqual(['m-aaa', 'm-zzz']);
  });
});

describe('mergeMemberLookup (org-members 우선, team-members는 보강만 — id 공간 불일치 대응)', () => {
  it('prefers org-members over team-members when both have the same id', () => {
    const lookup = mergeMemberLookup(
      [{ id: 'x1', name: 'Org Name', email: 'x1@example.com' }],
      [{ id: 'x1', name: 'Team Name' }],
    );
    expect(lookup.get('x1')).toEqual({ id: 'x1', name: 'Org Name', email: 'x1@example.com' });
  });

  it('falls back to team-members for an id only present there (id 공간 불일치 케이스)', () => {
    const lookup = mergeMemberLookup(
      [{ id: 'x1', name: 'Org Name' }],
      [{ id: 'x2', name: 'Team-only Name' }],
    );
    expect(lookup.get('x2')).toEqual({ id: 'x2', name: 'Team-only Name' });
  });

  it('falls back to email local-part when org-member has no name (nullish/빈문자열 폴백)', () => {
    const lookup = mergeMemberLookup(
      [{ id: 'x1', name: '  ', email: 'nobody@example.com' }],
      [],
    );
    expect(lookup.get('x1')?.name).toBe('nobody');
  });

  it('returns an empty map for two empty sources', () => {
    expect(mergeMemberLookup([], []).size).toBe(0);
  });
});

describe('extractSparklineValues (Ortega 지시 C2a 심화 — 가독성 개선용, 감시 신호 아님)', () => {
  const snap = (computed_at: string, hit_rate: number | null, resolved: number | null = 5): HistorySnapshot =>
    ({ computed_at, hit_rate, resolved });

  it('reverses BE order (computed_at DESC → 좌→우 시간순) so oldest is first', () => {
    // BE history는 최신이 먼저 온다(computed_at DESC) — 스파크라인은 시간순으로 읽혀야 하므로
    // 순서가 뒤집혀야 한다. 뒤집지 않으면 그래프가 시간 역행으로 그려진다(치명적 오독).
    const snapshots = [snap('2026-07-15T00:00:00Z', 0.9), snap('2026-07-01T00:00:00Z', 0.1)];
    expect(extractSparklineValues(snapshots)).toEqual([0.1, 0.9]);
  });

  it('excludes cold-start snapshots (hit_rate=null) — never plotted as 0 (E-VERIFY 왜곡 방지)', () => {
    const snapshots = [
      snap('2026-07-01T00:00:00Z', null, 0),
      snap('2026-07-08T00:00:00Z', 0.5),
      snap('2026-07-15T00:00:00Z', null, 0),
    ];
    expect(extractSparklineValues(snapshots)).toEqual([0.5]);
  });

  it('returns an empty array when every snapshot is cold-start', () => {
    expect(extractSparklineValues([snap('2026-07-01T00:00:00Z', null, 0)])).toEqual([]);
  });
});

describe('sparklinePoints (유나 가디언 지적 PR#2194 — 고정 0-1 스케일, 상대 min-max 정규화 금지)', () => {
  function yOf(pointsStr: string, index: number): number {
    return Number(pointsStr.split(' ')[index]!.split(',')[1]);
  }

  it('places near-identical values at near-identical y (상대정규화였다면 지그재그로 과장됐을 것)', () => {
    // 0.80→0.81→0.79 — 성과 그래프로 오독시키는 사례로 유나양이 직접 지적한 케이스.
    const points = sparklinePoints([0.8, 0.81, 0.79]);
    const ys = [0, 1, 2].map((i) => yOf(points, i));
    const maxSwing = Math.max(...ys) - Math.min(...ys);
    expect(maxSwing).toBeLessThan(1); // 20px 그리기영역 중 1px 미만 — 육안상 사실상 평평
  });

  it('renders a constant series flat at its true height, not pinned to the floor', () => {
    // range=0(전부 동일)일 때 구 상대정규화는 0으로 나눠 바닥(y=height-pad)에 고정시켰다 —
    // hit_rate=0.9(좋은 신뢰)인데 그래프상 최하단처럼 보이는 왜곡.
    const points = sparklinePoints([0.9, 0.9, 0.9]);
    const ys = [0, 1, 2].map((i) => yOf(points, i));
    expect(new Set(ys).size).toBe(1); // 셋 다 정확히 같은 높이
    const height = 24, pad = 2;
    const expectedY = height - pad - 0.9 * (height - pad * 2); // 상단 근처 — 바닥 아님
    expect(ys[0]).toBeCloseTo(expectedY);
  });

  it('maps hit_rate 0 to the floor and 1 to the ceiling (fixed 0-1 scale, not relative)', () => {
    const points = sparklinePoints([0, 1]);
    const height = 24, pad = 2;
    expect(yOf(points, 0)).toBeCloseTo(height - pad); // 0 → 바닥
    expect(yOf(points, 1)).toBeCloseTo(pad); // 1 → 천장
  });
});
