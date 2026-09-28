// story #4079(까디르 #4077 스캔 §4-4 처방) — verify-no-hardcoded-absolute-datetime.ts의
// 정탐/오탐 회귀 가드. lint_no_hardcoded_iso_timestamp.py의 backend/tests 자매 정책과
// 동형 구조(합성 fixture, 실물이 고쳐져도 이 테스트는 안 사라진다).
import { describe, expect, it } from 'vitest';
import { scanContent } from './verify-no-hardcoded-absolute-datetime';

describe('verify-no-hardcoded-absolute-datetime', () => {
  it('AC2 — #4453 원 사고 모양(재현): 실 Date.now() 비교가 다른 모듈에 있어도 scheduled_at류 필드는 잡는다', () => {
    const src = `
describe('B4', () => {
  it('scheduled=true면 예약 안내가 보인다', async () => {
    stubFetch({
      draftDetail: { scheduled: true, scheduled_at: '2026-09-20T00:00:00Z' },
    });
  });
});
`;
    const violations = scanContent(src, 'app/fixture.test.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0].text).toBe('2026-09-20T00:00:00Z');
  });

  it('AC2 — revert-confirm: FIXED_NOW/vi.spyOn(Date,\'now\')로 고친 형은 RED가 아니다', () => {
    const src = `
describe('B4', () => {
  const FIXED_NOW = new Date('2026-06-01T00:00:00Z').getTime();
  const RELATIVE_FUTURE = new Date(FIXED_NOW + 86400000).toISOString();
  let dateNowSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW); });
  afterEach(() => { dateNowSpy.mockRestore(); });

  it('scheduled=true면 예약 안내가 보인다', async () => {
    stubFetch({
      draftDetail: { scheduled: true, scheduled_at: RELATIVE_FUTURE },
    });
  });
});
`;
    expect(scanContent(src, 'app/fixture.test.tsx')).toEqual([]);
  });

  it('negative — live-now 호출이 스코프 안에 없으면 위험대 리터럴이 있어도 통과(순수 픽스처)', () => {
    const src = `
it('renders a row', () => {
  const createdAt = new Date(2026, 6, 17);
  expect(createdAt.getFullYear()).toBe(2026);
});
`;
    expect(scanContent(src, 'components/fixture.test.tsx')).toEqual([]);
  });

  it('positive — 같은 스코프에 실 Date.now() 호출이 있고 freeze/DI 관용구가 없으면 FAIL', () => {
    const src = `
it('compares to live now', () => {
  const boundary = Date.now();
  const scheduled = new Date(2026, 8, 20);
  expect(scheduled.getTime() > boundary).toBe(true);
});
`;
    const violations = scanContent(src, 'components/fixture.test.tsx');
    expect(violations).toHaveLength(1);
  });

  it('negative — 함수 단위 판정(파일 단위 아님): 무관한 다른 테스트의 Date.now()가 순수 픽스처 팩토리를 오탐시키지 않는다', () => {
    const src = `
function buildGate(id) {
  return { id, created_at: new Date(2026, 6, 17) };
}

it('unrelated test uses live now', () => {
  const deletedAt = Date.now();
  expect(deletedAt).toBeGreaterThan(0);
});
`;
    expect(scanContent(src, 'components/fixture.test.tsx')).toEqual([]);
  });

  it('negative — now 로컬 변수 DI 패턴(같은 스코프에 live-now 호출이 있어도 안전)', () => {
    const src = `
it('injects a fixed now', () => {
  const boundary = Date.now();
  const now = new Date(2026, 8, 1);
  expect(isRetroStale({ updated_at: '2026-07-01T00:00:00Z' }, now)).toBe(true);
});
`;
    expect(scanContent(src, 'components/fixture.test.tsx')).toEqual([]);
  });

  it('negative — FIXED_NOW류 이름으로 대입되면 스코프·live-now 여부와 무관하게 자가면제', () => {
    const src = `
describe('suite', () => {
  const FIXED_NOW = new Date(2026, 5, 1);
  it('uses live now unrelated', () => {
    const x = Date.now();
    expect(x).toBeGreaterThan(0);
  });
});
`;
    expect(scanContent(src, 'components/fixture.test.tsx')).toEqual([]);
  });

  it('negative — vi.setSystemTime/vi.useFakeTimers freeze 관용구', () => {
    const src = `
it('freezes with setSystemTime', () => {
  const boundary = Date.now();
  vi.setSystemTime(new Date(2026, 8, 1));
  expect(boundary).toBeDefined();
});
`;
    expect(scanContent(src, 'components/fixture.test.tsx')).toEqual([]);
  });

  it('negative — sentinel 연도(<=2021/>=2090)는 live-now 호출이 있어도 항상 안전', () => {
    const src = `
it('past and future sentinels', () => {
  const boundary = Date.now();
  const past = new Date(2020, 0, 1);
  const future = '2099-01-01T00:00:00Z';
  expect(past.getTime() < boundary).toBe(true);
  expect(future).toBeTruthy();
});
`;
    expect(scanContent(src, 'components/fixture.test.tsx')).toEqual([]);
  });

  it('positive — 모듈 최상위 상수도 scheduled_at류 필드명이면 live-now 게이트 없이 항상 위험 취급', () => {
    const src = `
const ROW = { id: 'r1', scheduled_at: '2026-09-20T00:00:00Z' };

it('uses ROW', () => {
  expect(ROW.id).toBe('r1');
});
`;
    const violations = scanContent(src, 'components/fixture.test.tsx');
    expect(violations).toHaveLength(1);
  });

  it('negative — 모듈 최상위 상수는 live-now 게이트를 안 탄다(파일 어딘가의 Date.now()와 무관한 필드명)', () => {
    const src = `
const ROW = { id: 'r1', published_at: '2026-09-05T00:00:00Z' };

it('unrelated uses live now', () => {
  const x = Date.now();
  expect(x).toBeGreaterThan(0);
});
`;
    expect(scanContent(src, 'components/fixture.test.tsx')).toEqual([]);
  });

  it('ALLOWLIST 항목은 등재 안 된 파일이면 여전히 FAIL한다(말없이 넓어지는 예외 금지)', () => {
    const src = `
it('temporal field with no comparison', () => {
  const boundary = Date.now();
  const scheduled = '2026-09-10T00:00:00Z';
  expect(scheduled).toBeTruthy();
});
`;
    // scheduled_at 필드명이 아니라 변수명일 뿐이므로 live-now 게이트를 타고, ALLOWLIST에
    // 없는 파일이면 여전히 FAIL.
    const violations = scanContent(src, 'components/not_the_allowlisted_file.test.tsx');
    expect(violations).toHaveLength(1);
  });

  it('story #4457 PR 리뷰 — line 없는 ALLOWLIST 항목은 같은 파일의 같은 리터럴을 줄 무관하게 전부 통과시킨다', () => {
    const src = `
it('a', () => {
  const boundary = Date.now();
  const x = { scheduled_at: '2026-09-05T00:00:00Z' };
  expect(x).toBeTruthy();
});

it('b', () => {
  const boundary = Date.now();
  const y = { scheduled_at: '2026-09-05T00:00:00Z' };
  expect(y).toBeTruthy();
});
`;
    // 실 ALLOWLIST의 page.test.tsx 항목처럼 같은 파일에 같은 리터럴이 두 줄에 걸쳐
    // 있어도(여기선 다른 파일명으로 시뮬레이트하지 않고 ALLOWLIST에 실제로 등재된
    // 파일 경로를 그대로 써서 검증한다) line 없이 둘 다 통과해야 한다.
    const violations = scanContent(src, 'app/(authenticated)/content/channel-posts/[draftId]/page.test.tsx');
    expect(violations).toEqual([]);
  });
});
