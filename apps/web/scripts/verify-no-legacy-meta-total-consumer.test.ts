import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFileContent, scanRepo } from './verify-no-legacy-meta-total-consumer';

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

describe('scanRepo — story #3761 후속(실 트리 실행)', () => {
  // 지금 develop(이 PR 처리 뒤) — apps/web/src 전수에서 legacy meta.total 읽기는
  // ALLOWLIST(derive-loop-queue.ts:77, 근거는 스크립트 상단 docstring) 하나만 남고 0건.
  it('실 트리(apps/web/src) — legacy 읽기 0건(ALLOWLIST 제외), ALLOWLIST는 전부 실제로 걸린다', () => {
    const { refs, fileCount, allowlistHit } = scanRepo(SRC_ROOT);
    expect(fileCount).toBeGreaterThan(1500);
    expect(refs).toEqual([]);
    expect(allowlistHit.size).toBe(1);
  });
});
