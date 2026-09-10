import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFileContent, scanRepo } from './verify-no-legacy-meta-total';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/api');

describe('scanFileContent — story #3761 셀프테스트', () => {
  // 양성대조 — apiSuccess 호출의 meta 인자에 legacy `total` 프로퍼티가 있으면 RED.
  it('⭐apiSuccess(data, { total: N }) → RED', () => {
    const src = `
      export async function GET() {
        return apiSuccess(data, { total: 5 });
      }
    `;
    expect(scanFileContent(src, 'fake/route.ts')).toEqual([{ file: 'fake/route.ts', line: 3 }]);
  });

  it('⭐shorthand { total } → RED', () => {
    const src = `
      const total = 5;
      return apiSuccess(data, { total });
    `;
    expect(scanFileContent(src, 'fake/route.ts')).toEqual([{ file: 'fake/route.ts', line: 3 }]);
  });

  it('⭐스프레드+조건부 형(구 stories/backlog 관례) — ...(cond ? { total: N } : {}) → RED', () => {
    const src = `
      return apiSuccess(data, { limit: 10, ...(hasTotal ? { total: n } : {}) });
    `;
    const refs = scanFileContent(src, 'fake/route.ts');
    expect(refs).toHaveLength(1);
  });

  // 음성대조 — 정본 totalCount는 GREEN.
  it('{ totalCount: N } → GREEN', () => {
    const src = `return apiSuccess(data, { totalCount: 5 });`;
    expect(scanFileContent(src, 'fake/route.ts')).toEqual([]);
  });

  it('{ totalCount: null } → GREEN(모른다)', () => {
    const src = `return apiSuccess(data, { totalCount: null });`;
    expect(scanFileContent(src, 'fake/route.ts')).toEqual([]);
  });

  // 부분 문자열 무관 낱말 — totalPages/subtotal은 이름이 정확히 total이 아니므로 GREEN
  // (오탐 방지 — 카드 스코프는 「총계」 낱말 하나, 다른 total* 낱말은 무관).
  it('totalPages/subtotal 등 부분 문자열은 GREEN(이름이 정확히 total일 때만 위반)', () => {
    const src = `return apiSuccess(data, { totalPages: 3, subtotal: 10 });`;
    expect(scanFileContent(src, 'fake/route.ts')).toEqual([]);
  });

  it('주석 안의 total: 은 안 잡힌다(오탐 0 — AST가 comment를 trivia로 자연 배제)', () => {
    const src = `
      // return apiSuccess(data, { total: 999 });
      return apiSuccess(data, { totalCount: 1 });
    `;
    expect(scanFileContent(src, 'fake/route.ts')).toEqual([]);
  });

  it('파싱 실패(문법 오류)면 조용히 통과하지 않고 throw한다(story #2710 AC4 동형)', () => {
    expect(() => scanFileContent('export function {{{ broken', 'broken.ts')).toThrow(/파싱 실패/);
  });
});

describe('scanRepo — story #3761(실 트리 실행)', () => {
  // 지금 develop(#3761 처리 뒤) — API route.ts 전수 위반 0. 되돌리면(누군가 total을 다시
  // 쓰면) RED.
  it('실 트리(apps/web/src/app/api) — legacy total 프로퍼티 0건', () => {
    const { refs, fileCount } = scanRepo(API_ROOT);
    expect(fileCount).toBeGreaterThan(400);
    expect(refs).toEqual([]);
  });
});
