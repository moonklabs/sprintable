import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mayReadLegacyTotal, scanFileContent, scanRepo } from './verify-no-legacy-meta-total-consumer';
import { measureFsReads } from './test-utils/fs-work';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

describe('scanFileContent — story #3761 후속(소비처 가드) 셀프테스트', () => {
  // 양성대조 — 프로퍼티 접근 3형.
  it('⭐meta.total → RED', () => {
    const src = `const x = json.meta.total;`;
    expect(scanFileContent(src, 'fake.ts')).toEqual([{ file: 'fake.ts', line: 1 }]);
  });

  it('⭐meta?.total(옵셔널 체이닝) → RED', () => {
    const src = `const x = json.meta?.total ?? 0;`;
    expect(scanFileContent(src, 'fake.ts')).toEqual([{ file: 'fake.ts', line: 1 }]);
  });

  it('⭐meta[\'total\']/meta["total"](대괄호 접근) → RED', () => {
    const src = `
      const a = meta['total'];
      const b = meta["total"];
    `;
    const refs = scanFileContent(src, 'fake.ts');
    expect(refs).toEqual([{ file: 'fake.ts', line: 2 }, { file: 'fake.ts', line: 3 }]);
  });

  it('⭐깊이 무관 — res.data.meta?.total도 걸린다(마지막 두 마디만 본다)', () => {
    const src = `const x = res.data.meta?.total;`;
    expect(scanFileContent(src, 'fake.ts')).toEqual([{ file: 'fake.ts', line: 1 }]);
  });

  // 음성대조 — 정본 totalCount는 GREEN.
  it('meta?.totalCount → GREEN(정본)', () => {
    const src = `const x = json.meta?.totalCount ?? null;`;
    expect(scanFileContent(src, 'fake.ts')).toEqual([]);
  });

  // 음성대조 — meta가 아닌 다른 객체의 .total은 이 축과 무관(오탐 방지).
  it('meta가 아닌 객체의 .total(예: cart.total)은 GREEN(다른 개념)', () => {
    const src = `const price = cart.total;`;
    expect(scanFileContent(src, 'fake.ts')).toEqual([]);
  });

  it('totalPages/subtotal 등 부분 문자열은 GREEN(이름이 정확히 total일 때만 위반)', () => {
    const src = `const x = meta.totalPages; const y = meta.subtotal;`;
    expect(scanFileContent(src, 'fake.ts')).toEqual([]);
  });

  it('주석 안의 meta.total은 안 잡힌다(오탐 0 — AST가 comment를 trivia로 자연 배제)', () => {
    const src = `
      // const x = json.meta.total;
      const y = json.meta?.totalCount;
    `;
    expect(scanFileContent(src, 'fake.ts')).toEqual([]);
  });

  it('파싱 실패(문법 오류)면 조용히 통과하지 않고 throw한다(story #2710 AC4 동형)', () => {
    expect(() => scanFileContent('export function {{{ broken', 'broken.ts')).toThrow(/파싱 실패/);
  });
});

describe('mayReadLegacyTotal — story #4408(파싱 전 거름)', () => {
  it('글자 total이 없는 파일은 거른다 · 있으면 파싱한다', () => {
    expect(mayReadLegacyTotal('export const x = res.meta.count;')).toBe(false);
    expect(mayReadLegacyTotal('const n = res.meta.total;')).toBe(true);
  });

  it('⭐유니코드 이스케이프 식별자 — AST는 total로 풀어 걸고, 거름도 통과시킨다(거름이 위반을 숨기지 않음)', () => {
    const src = 'const n = res.meta.\\u0074otal;';
    expect(src.includes('total')).toBe(false);
    expect(scanFileContent(src, 'escaped.ts')).toHaveLength(1);
    expect(mayReadLegacyTotal(src)).toBe(true);
  });
});

describe('scanRepo — story #3761 후속(실 트리 실행)', () => {
  // 지금 develop(이 PR 처리 뒤) — apps/web/src 전수에서 legacy meta.total 읽기는
  // ALLOWLIST(derive-loop-queue.ts:77, 근거는 스크립트 상단 docstring) 하나만 남고 0건.
  // story #4408 — 시한은 CI 실측으로: 예전 6000ms(로컬 동시부하 재현 최댓값 1913ms × 3)는 CI 실제
  // (2026-09-28 CI work 26 run · 전 파일 파싱 판)에서 중앙값 5498ms · 최댓값 6042ms였고 6042 · 6651ms에서
  // 시간 초과 — 로컬 부하 재현이 CI 전체 병렬을 3.5배쯤 덜 쟀다. 이제 `total` 글자 거름으로 파싱이 1/12쯤으로
  // 줄었지만, 시한은 거름 전 CI 최댓값 6651ms의 4.5배 = 30000ms(거름이 풀려도 CI 부하로는 안 넘고, 무한 대기는
  // 여전히 RED). 시한으로 성능 예산을 걸지 않는다(story #4333).
  it('실 트리(apps/web/src) — legacy 읽기 0건(ALLOWLIST 제외), ALLOWLIST는 전부 실제로 걸린다', () => {
    // story #4333 — 일의 양은 결정적으로: 한 스캔에서 같은 파일을 두 번 읽으면 RED.
    const { result, maxPerFile, files: filesRead } = measureFsReads(() => scanRepo(SRC_ROOT));
    const { refs, fileCount, parsedCount, allowlistHit } = result;
    expect(maxPerFile.count, `${maxPerFile.file} — 한 스캔에서 두 번 이상 읽음(일이 늘었다)`).toBeLessThanOrEqual(1);
    expect(filesRead).toBe(fileCount);
    expect(fileCount).toBeGreaterThan(1500);
    // 거름이 헛돌지 않는다 — 일부만 파싱하되 0은 아님(ALLOWLIST 자리가 파싱돼야 걸린다).
    expect(parsedCount).toBeGreaterThan(0);
    expect(parsedCount).toBeLessThan(fileCount);
    expect(refs).toEqual([]);
    expect(allowlistHit.size).toBe(1);
  }, 30_000);
});
