import { describe, expect, it } from 'vitest';
import { isColdStart, groupRosterByRole, mergeMemberLookup, resolveRoleLabel, sortGroupMembersByName, extractSparklineValues, sparklinePoints, disambiguatedNames, withSummaryNames, rosterDisplayName, rosterRealName, rosterSortLookup } from './trust-utils';
import type { RosterMember, HistorySnapshot } from './trust-utils';

// story #3735(D1) — groupRosterByRole이 이제 t(Translator)를 받아 기본 5키(role_key)면
// i18n 정본을 쓴다(trust-utils.test.ts 아래 별도 describe가 그 경로를 직접 잰다). 이
// 기존 스위트의 픽스처는 role_key='dev'(기본 5키 밖 — 커스텀 취급이라 role_label을
// 그대로 쓴다)·'qa'(기본 5키 — i18n 경유)를 섞어 쓰므로, 실제 ko.json 값과 동일한
// 스텁을 줘 순수 함수 계약(role_key→i18n)까지 같이 지킨다.
const stubT = (key: string): string => ({
  trustRoleLabelImplementation: '개발',
  trustRoleLabelPo: 'PO',
  trustRoleLabelQa: 'QA',
  trustRoleLabelDesign: '디자인',
  trustRoleLabelDevops: 'DevOps',
} as Record<string, string>)[key] ?? key;

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

// story #3735(D1, 유나 定) — role_label은 DB값(조직 생성 시 1회 시드, locale 무관)이라
// i18n이 아니다. DB 무변 — 기본 5키(role_key로만 판정)면 i18n 정본이 role_label을
// 앞지르고(실제 바뀌는 낱말: "구현"→"개발" 하나), 기본 5키가 아니면(=조직이 만든 커스텀
// 역할) DB의 role_label이 그대로 이긴다.
describe('resolveRoleLabel (story #3735·D1 — 기본 5키 i18n 정본, 커스텀은 DB가 이긴다)', () => {
  it('기본 5키(implementation)는 DB role_label("구현")을 무시하고 i18n 정본("개발")을 쓴다', () => {
    expect(resolveRoleLabel('implementation', '구현', stubT)).toBe('개발');
  });

  it('기본 5키(po·qa·design·devops)도 i18n 정본을 쓴다 — 실측상 기존 DB 값과 이미 같아 문구는 안 바뀐다', () => {
    expect(resolveRoleLabel('po', 'PO', stubT)).toBe('PO');
    expect(resolveRoleLabel('qa', 'QA', stubT)).toBe('QA');
    expect(resolveRoleLabel('design', '디자인', stubT)).toBe('디자인');
    expect(resolveRoleLabel('devops', 'DevOps', stubT)).toBe('DevOps');
  });

  it('기본 5키가 아니면(커스텀 역할) DB role_label이 이긴다 — FE가 조직이 지은 이름을 덮지 않는다', () => {
    expect(resolveRoleLabel('growth', '그로스', stubT)).toBe('그로스');
  });

  it('커스텀 역할인데 role_label이 null이면 role_key로 폴백한다(기존 계약 보존)', () => {
    expect(resolveRoleLabel('growth', null, stubT)).toBe('growth');
  });

  // 뮤테이션 대조 — role_key 판정을 role_label 판정으로 잘못 바꾸면(예: label==='구현'으로
  // 분기) 이 케이스가 못 잡는 사각이 생긴다는 것 자체를 자가 증명. 기본 키인데 커스텀
  // 조직이 우연히 같은 label 문자열을 안 쓰는 상황을 반대로 검산 — role_key가 유일한
  // 판정축임을 고정.
  it('role_key가 유일한 판정축이다 — 커스텀 role_key에 기본 키와 같은 label이 와도 커스텀 취급', () => {
    expect(resolveRoleLabel('growth', 'PO', stubT)).toBe('PO');
    // 위는 우연히 i18n 값과 같아 구분이 안 되므로, 다른 값으로 재확인.
    expect(resolveRoleLabel('growth', '구현', stubT)).toBe('구현');
  });

  // story #3735 CHANGES(카디르 QA 지적) — DEFAULT_ROLE_LABEL_KEY가 객체 리터럴이라
  // role_key가 Object.prototype 이름(constructor·toString·hasOwnProperty 등)이면
  // 상속 함수가 truthy로 걸려 "커스텀이 이긴다" 계약이 깨진다(함수 객체가 t()에
  // 들어가는 사고). Object.hasOwn 가드가 그 자리를 막는지 직접 잰다.
  it('role_key가 Object.prototype 이름이어도(constructor 등) 커스텀 DB label이 그대로 이긴다', () => {
    expect(resolveRoleLabel('constructor', '조직 커스텀', stubT)).toBe('조직 커스텀');
    expect(resolveRoleLabel('toString', '조직 커스텀2', stubT)).toBe('조직 커스텀2');
    expect(resolveRoleLabel('hasOwnProperty', null, stubT)).toBe('hasOwnProperty');
  });
});

describe('groupRosterByRole (E-VERIFY 중립 정렬 — 성과순 금지, 라벨 이름순만)', () => {
  const row = (member_id: string, role_key: string, role_label: string | null, hit_rate: number | null = null, resolved: number | null = 0) =>
    ({ member_id, role_key, role_label, hit_rate, resolved, computed_at: '2026-07-15T00:00:00Z', pending: null });

  it('groups rows by role_label, sorted alphabetically regardless of hit_rate (순위 금지 회귀가드)', () => {
    // QA의 hit_rate(0.1)가 개발(0.95)보다 훨씬 낮게 설계 — hit_rate 내림차순 정렬이었다면
    // '개발'이 먼저 와야 한다. 실제로는 로케일 문자열 비교('Q' < '개')로 'QA'가 먼저 온다 —
    // 성과순이 아니라 이름순임을 명확히 갈리는 픽스처로 증명(뮤테이션 셀프체크로 검증됨).
    const rows = [
      row('m1', 'qa', 'QA', 0.1, 10),
      row('m2', 'dev', '개발', 0.95, 10),
      row('m3', 'dev', '개발', 0.99, 10),
    ];
    const grouped = groupRosterByRole(rows, stubT);
    expect(grouped.map(([label]) => label)).toEqual(['QA', '개발']);
    expect(grouped.find(([label]) => label === '개발')?.[1]).toHaveLength(2);
  });

  it('falls back to role_key when role_label is null(기본 5키 밖 — 커스텀 취급)', () => {
    const grouped = groupRosterByRole([row('m1', 'dev', null)], stubT);
    expect(grouped).toEqual([['dev', [row('m1', 'dev', null)]]]);
  });

  it('returns empty for an empty roster', () => {
    expect(groupRosterByRole([], stubT)).toEqual([]);
  });
});

describe('sortGroupMembersByName (유나 가디언 지적 PR#2191 — within-group 순위 누수 fix)', () => {
  const row = (member_id: string, hit_rate: number | null = null, resolved: number | null = 0) =>
    ({ member_id, role_key: 'dev', role_label: '개발', hit_rate, resolved, computed_at: '2026-07-15T00:00:00Z', pending: null });
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

  // story #4285(까디르 P2 둘째) — 예전엔 이메일 앞부분을 이름으로 채웠다(«nobody»). BE는 같은 행에 이메일 폴백 없이 name null(#3755)이라
  // 화면만 이메일을 냈다 — 이제 이름은 빈 채로 두고(표시는 rosterDisplayName이 «이름 없는 구성원») 이메일은 구분 꼬리 재료로만 남는다.
  it('does not turn the email local-part into a name when org-member has no name (이메일 폴백 0)', () => {
    const lookup = mergeMemberLookup(
      [{ id: 'x1', name: '  ', email: 'nobody@example.com' }],
      [],
    );
    expect(lookup.get('x1')).toEqual({ id: 'x1', name: '', email: 'nobody@example.com' });
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

// [SID:4282 · 유나 결정] 같은 이름 · 다른 구성원 행에만 구분 꼬리(역할 → 이메일 → ID 앞 8자).
describe('disambiguatedNames (SID:4282 — 같은 이름 두 줄 구분)', () => {
  const role = (r: string) => ({ owner: '소유자', admin: '관리자', member: '구성원' } as Record<string, string>)[r] ?? r;
  const L = (rows: Array<{ id: string; name: string; email?: string; role?: string }>) => new Map(rows.map((r) => [r.id, r]));
  it('실측 모양: 송윤재 소유자 · 관리자 두 계정 → 역할 꼬리 · 이름이 하나뿐인 행은 그대로', () => {
    const lookup = L([
      { id: 'e75ca548-aaaa', name: '송윤재', email: 'iamyoonjae@moonklabs.com', role: 'owner' },
      { id: '2fd14616-bbbb', name: '송윤재', email: 'sellerking@moonklabs.com', role: 'admin' },
      { id: 'c3', name: 'dosunyun', email: 'dosunyun@moonklabs.com', role: 'admin' },
    ]);
    const out = disambiguatedNames(['e75ca548-aaaa', '2fd14616-bbbb', 'c3'], (id) => lookup.get(id)!.name, lookup, role);
    expect(out.get('e75ca548-aaaa')).toBe('송윤재 · 소유자');
    expect(out.get('2fd14616-bbbb')).toBe('송윤재 · 관리자');
    expect(out.get('c3')).toBe('dosunyun');
  });
  it('역할이 같으면 이메일 · 이메일도 없으면 ID 앞 8자', () => {
    const lookup = L([
      { id: 'aaaaaaaa-1111', name: '김', email: 'a@x.com', role: 'member' },
      { id: 'bbbbbbbb-2222', name: '김', email: 'b@x.com', role: 'member' },
      { id: 'cccccccc-3333', name: '김' },
    ]);
    const out = disambiguatedNames(['aaaaaaaa-1111', 'bbbbbbbb-2222', 'cccccccc-3333'], (id) => lookup.get(id)!.name, lookup, role);
    expect(out.get('aaaaaaaa-1111')).toBe('김 · a@x.com');
    expect(out.get('bbbbbbbb-2222')).toBe('김 · b@x.com');
    expect(out.get('cccccccc-3333')).toBe('김 · cccccccc');
  });
  it('셋 중 역할이 하나만 다르면 그 사람만 역할 · 나머지는 이메일', () => {
    const lookup = L([
      { id: 'o1', name: '이', email: 'o@x.com', role: 'owner' },
      { id: 'm1', name: '이', email: 'm1@x.com', role: 'member' },
      { id: 'm2', name: '이', email: 'm2@x.com', role: 'member' },
    ]);
    const out = disambiguatedNames(['o1', 'm1', 'm2'], (id) => lookup.get(id)!.name, lookup, role);
    expect([out.get('o1'), out.get('m1'), out.get('m2')]).toEqual(['이 · 소유자', '이 · m1@x.com', '이 · m2@x.com']);
  });
  it('같은 사람이 직무 둘로 두 행이면(member_id 같음) 꼬리 없음', () => {
    const lookup = L([{ id: 'p1', name: '박', email: 'p@x.com', role: 'admin' }]);
    const out = disambiguatedNames(['p1', 'p1'], (id) => lookup.get(id)!.name, lookup, role);
    expect(out.get('p1')).toBe('박');
  });
  it('명단에 없는 구성원 둘(같은 «알 수 없는 구성원») → ID 앞 8자로 갈림', () => {
    const lookup = L([]);
    const out = disambiguatedNames(['11111111-x', '22222222-y'], () => '알 수 없는 구성원', lookup, role);
    expect(out.get('11111111-x')).toBe('알 수 없는 구성원 · 11111111');
    expect(out.get('22222222-y')).toBe('알 수 없는 구성원 · 22222222');
  });
  it('mergeMemberLookup이 org-members의 role을 싣는다', () => {
    const lookup = mergeMemberLookup([{ id: 'o', name: 'A', email: 'a@x.com', role: 'owner' }], [{ id: 't', name: 'B' }]);
    expect(lookup.get('o')?.role).toBe('owner');
    expect(lookup.get('t')?.role).toBeUndefined();
  });
});

// [SID:4282 · 까디르 P2] 같은 이름 행 순서는 입력(BE 응답) 순서와 무관해야 한다 — 새로고침마다 두 줄이 자리를 바꾸지 않게.
describe('sortGroupMembersByName — 같은 이름은 member_id · role_key로 끊는다(SID:4282)', () => {
  const row = (member_id: string, role_key = 'dev') => ({ member_id, role_key, role_label: '개발', hit_rate: null, resolved: 0, computed_at: '2026-09-09T00:00:00Z', pending: 0 });
  const lookup = new Map([
    ['e75ca548', { id: 'e75ca548', name: '송윤재' }],
    ['2fd14616', { id: '2fd14616', name: '송윤재' }],
    ['c3', { id: 'c3', name: 'dosunyun' }],
  ]);
  it('입력 순서를 뒤집어도 출력 순서가 같다', () => {
    const a = sortGroupMembersByName([row('e75ca548'), row('2fd14616'), row('c3')], lookup).map((r) => r.member_id);
    const b = sortGroupMembersByName([row('2fd14616'), row('c3'), row('e75ca548')], lookup).map((r) => r.member_id);
    expect(a).toEqual(b);
    expect(a).toEqual(['c3', '2fd14616', 'e75ca548']);
  });
  it('같은 사람의 직무 두 행도 순서가 고정(role_key)', () => {
    const one = new Map([['p1', { id: 'p1', name: '박' }]]);
    const a = sortGroupMembersByName([row('p1', 'qa'), row('p1', 'dev')], one).map((r) => r.role_key);
    const b = sortGroupMembersByName([row('p1', 'dev'), row('p1', 'qa')], one).map((r) => r.role_key);
    expect(a).toEqual(['dev', 'qa']);
    expect(b).toEqual(['dev', 'qa']);
  });
});

describe('withSummaryNames(story #4285)', () => {
  it('응답 이름이 정본 — 없던 행은 채우고 · 있던 행은 이름만 바꾸고 이메일은 둔다 · 이름 없는 행(지워진 구성원)은 건드리지 않는다', () => {
    const lookup = new Map([['h1', { id: 'h1', name: 'song', email: 'song@x.dev' }]]);
    const base = { role_key: 'dev', role_label: null, hit_rate: null, resolved: 0, computed_at: '2026-09-24T00:00:00+00:00', pending: 0 };
    const out = withSummaryNames(lookup, [
      { ...base, member_id: 'h1', name: '송윤재' },
      { ...base, member_id: 'a1', name: '페드루 올리베이라' },
      { ...base, member_id: 'gone', name: null, member_deleted: true },
    ]);
    expect(out.get('h1')).toEqual({ id: 'h1', name: '송윤재', email: 'song@x.dev' });
    expect(out.get('a1')).toEqual({ id: 'a1', name: '페드루 올리베이라' });
    expect(out.has('gone')).toBe(false);
    expect(lookup.get('h1')!.name).toBe('song'); // 원본 맵은 그대로(새 맵을 돌려준다).
  });
});

describe('rosterDisplayName · mergeMemberLookup — 날것 `?` 0(story #4285 · 까디르 P2)', () => {
  const base = { role_key: 'dev', role_label: null, hit_rate: null, resolved: 0, computed_at: '2026-09-24T00:00:00+00:00', pending: 0 };
  const labels = { unknown: '알 수 없는 구성원', unnamed: '이름 없는 구성원' };

  it('지워짐 → unknown · 살아 있고 이름 빔 → unnamed · 이름 있음 → 이름 · 옛 서버(플래그 없음)에 이름 없음 → unknown', () => {
    const lookup = new Map([['a', { id: 'a', name: '페드루' }]]);
    expect(rosterDisplayName({ ...base, member_id: 'x', member_deleted: true }, lookup, labels)).toBe(labels.unknown);
    expect(rosterDisplayName({ ...base, member_id: 'y', name: null, member_deleted: false }, lookup, labels)).toBe(labels.unnamed);
    expect(rosterDisplayName({ ...base, member_id: 'a', name: '페드루', member_deleted: false }, lookup, labels)).toBe('페드루');
    expect(rosterDisplayName({ ...base, member_id: 'z' }, lookup, labels)).toBe(labels.unknown);
  });

  it('mergeMemberLookup은 이름을 못 정한 항목을 만들지 않는다(리터럴 `?` 0)', () => {
    const lookup = mergeMemberLookup([{ id: 'o1', name: null, email: null }], [{ id: 't1', name: null }, { id: 't2', name: '  ' }]);
    expect(lookup.size).toBe(0);
    expect([...lookup.values()].map((m) => m.name)).not.toContain('?');
  });
});


describe('새 서버는 요약 이름만 · 이메일 폴백 0(story #4285 · 까디르 P2 둘째)', () => {
  const base = { role_key: 'dev', role_label: null, hit_rate: null, resolved: 0, computed_at: '2026-09-24T00:00:00+00:00', pending: 0 };
  const lookup = new Map([['h', { id: 'h', name: 'jane.doe', email: 'jane.doe@x.dev' }]]);

  it('member_deleted가 있으면 조회 이름을 안 본다 — name null → 없음 · 옛 서버(플래그 없음)만 조회 이름', () => {
    expect(rosterRealName({ ...base, member_id: 'h', name: null, member_deleted: false }, lookup)).toBeNull();
    expect(rosterRealName({ ...base, member_id: 'h' }, lookup)).toBe('jane.doe');
  });

  it('mergeMemberLookup은 이메일 앞부분을 이름으로 만들지 않는다(이메일은 꼬리 재료로만 남김)', () => {
    const m = mergeMemberLookup([{ id: 'h', name: null, email: 'jane.doe@x.dev' }], []);
    expect(m.get('h')).toEqual({ id: 'h', name: '', email: 'jane.doe@x.dev' });
  });

  it('정렬 조회엔 진짜 이름만 — 이름 없는 행은 싣지 않는다(이름 있는 행 뒤로)', () => {
    const out = rosterSortLookup([
      { ...base, member_id: 'h', name: null, member_deleted: false },
      { ...base, member_id: 'n', name: '가나다', member_deleted: false },
    ], lookup);
    expect([...out.keys()]).toEqual(['n']);
  });
});
