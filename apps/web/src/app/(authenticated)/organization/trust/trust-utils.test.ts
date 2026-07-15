import { describe, expect, it } from 'vitest';
import { isColdStart, groupRosterByRole, mergeMemberLookup } from './trust-utils';

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
