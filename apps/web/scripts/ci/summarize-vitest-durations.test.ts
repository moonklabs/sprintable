import { describe, expect, it } from 'vitest';
import { extractDurationEntries, formatTopTable } from './summarize-vitest-durations.mjs';

// story #3904 — CI가 개별 테스트 duration을 로그에 안 남기던 갭(story #3902의 「측정치×3」
// 이 CI 로그 실측 대신 로컬 5회 관측으로 대체된 원인) 처방. 이 파일은 순수 로직(extractDurationEntries·
// formatTopTable)만 픽스처로 검증한다 — 파일 I/O·vitest 실 실행은 CI 워크플로 자체가 통합
// 검증(실 run에서 artifact 읽기, PR 본문 양성대조).

function fakeRaw(files: { name: string; tests: { fullName: string; duration: number }[] }[]) {
  return {
    testResults: files.map((f) => ({
      name: f.name,
      assertionResults: f.tests.map((t) => ({ fullName: t.fullName, duration: t.duration })),
    })),
  };
}

describe('extractDurationEntries', () => {
  it('절대경로를 repoRoot 기준 상대경로로 바꾸고 ms를 반올림한다', () => {
    const raw = fakeRaw([
      { name: '/repo/apps/web/scripts/foo.test.ts', tests: [{ fullName: 'a > b', duration: 12.6 }] },
    ]);
    const entries = extractDurationEntries(raw, '/repo');
    expect(entries).toEqual([{ file: 'apps/web/scripts/foo.test.ts', test: 'a > b', ms: 13 }]);
  });

  it('내림차순 정렬한다(가장 느린 것이 먼저)', () => {
    const raw = fakeRaw([
      {
        name: '/repo/f.test.ts',
        tests: [
          { fullName: 'slow', duration: 500 },
          { fullName: 'fast', duration: 5 },
          { fullName: 'mid', duration: 50 },
        ],
      },
    ]);
    const entries = extractDurationEntries(raw, '/repo');
    expect(entries.map((e) => e.test)).toEqual(['slow', 'mid', 'fast']);
  });

  it('여러 파일에 걸친 결과를 하나의 배열로 합친다', () => {
    const raw = fakeRaw([
      { name: '/repo/a.test.ts', tests: [{ fullName: 'x', duration: 1 }] },
      { name: '/repo/b.test.ts', tests: [{ fullName: 'y', duration: 2 }] },
    ]);
    const entries = extractDurationEntries(raw, '/repo');
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.file)).toEqual(['b.test.ts', 'a.test.ts']); // y(2ms) 먼저
  });

  it('duration이 숫자가 아닌 assertion(예: skipped)은 건너뛴다(타입 에러 대신 조용히 skip)', () => {
    const raw = {
      testResults: [
        {
          name: '/repo/f.test.ts',
          assertionResults: [
            { fullName: 'has duration', duration: 10 },
            { fullName: 'skipped, no duration' }, // duration 필드 자체가 없음
          ],
        },
      ],
    };
    const entries = extractDurationEntries(raw, '/repo');
    expect(entries).toEqual([{ file: 'f.test.ts', test: 'has duration', ms: 10 }]);
  });

  it('testResults가 비어 있거나 없으면 빈 배열(타입 에러 아님)', () => {
    expect(extractDurationEntries({}, '/repo')).toEqual([]);
    expect(extractDurationEntries({ testResults: [] }, '/repo')).toEqual([]);
  });

  it('⭐뮤테이션 킬 대상 — ms 반올림이 실제로 일어난다(Math.round 확認, 문자열 결합 등으로 착각 방지)', () => {
    const raw = fakeRaw([{ name: '/repo/f.test.ts', tests: [{ fullName: 't', duration: 0.4 }] }]);
    const entries = extractDurationEntries(raw, '/repo');
    expect(entries[0].ms).toBe(0); // 0.4 반올림 → 0(=Math.round지 Math.ceil이 아님을 고정)
  });
});

describe('formatTopTable', () => {
  it('상위 N개만 표에 담고 「전체 M건 중」을 totalCount로 표기한다(잘린 나머지도 건수는 안다)', () => {
    const entries = [
      { file: 'a.test.ts', test: 'x', ms: 100 },
      { file: 'b.test.ts', test: 'y', ms: 50 },
      { file: 'c.test.ts', test: 'z', ms: 10 },
    ];
    const table = formatTopTable(entries, 2, entries.length);
    expect(table).toContain('상위 2(전체 3건 중');
    expect(table).toContain('a.test.ts');
    expect(table).toContain('b.test.ts');
    expect(table).not.toContain('c.test.ts');
  });

  it('테스트명이 120자를 넘으면 잘라낸다(로그 폭주 방지 — 표 한 줄이 과도하게 길어지지 않게)', () => {
    const longName = 'x'.repeat(200);
    const entries = [{ file: 'a.test.ts', test: longName, ms: 1 }];
    const table = formatTopTable(entries, 30, 1);
    expect(table).toContain('x'.repeat(120));
    expect(table).not.toContain('x'.repeat(121));
  });

  it('빈 배열이면 표 헤더만 있고 데이터 행은 0개(에러 아님)', () => {
    const table = formatTopTable([], 30, 0);
    expect(table).toContain('상위 0(전체 0건 중');
  });
});
