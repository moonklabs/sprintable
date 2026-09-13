import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractHits } from './verify-no-unformatted-usage-count';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

describe('extractHits — 순수 판정 함수(story #3808 — 사용량 카운트 천 단위 구분)', () => {
  it('⭐실 사고 픽스처 — 처방 前 channels/page.tsx 원문을 그대로 잡는다(회귀 0)', () => {
    const hits = extractHits(
      "        ? t('channelYoutubeUsageLine', { used: usage.used_units, limit: usage.limit_units })",
      'app/(authenticated)/organization/channels/page.tsx',
    );
    expect(hits).toEqual([
      { file: 'app/(authenticated)/organization/channels/page.tsx', line: 1, field: 'used_units' },
      { file: 'app/(authenticated)/organization/channels/page.tsx', line: 1, field: 'limit_units' },
    ]);
  });

  it('formatCount로 고친 뒤에는 안 잡는다(회귀 0 — 실제 처방 후 원문)', () => {
    const hits = extractHits(
      "        ? t('channelYoutubeUsageLine', { used: formatCount(usage.used_units, locale), limit: formatCount(usage.limit_units, locale) })",
      'app/(authenticated)/organization/channels/page.tsx',
    );
    expect(hits).toEqual([]);
  });

  it('remaining_units도 같은 축으로 잡는다', () => {
    expect(extractHits('const x = usage.remaining_units;', 'f.tsx')).toEqual([
      { file: 'f.tsx', line: 1, field: 'remaining_units' },
    ]);
  });

  it('타입 선언(점 없음, `used_units: number;`)은 애초에 매치 대상이 아니다(오탐 0)', () => {
    // 인터페이스 필드 선언은 `.used_units`가 아니라 `used_units:` — 정규식이
    // 점(.) 뒤의 실 프로퍼티 접근만 보므로 구조적으로 안 걸린다.
    expect(extractHits('  used_units: number;', 'f.tsx')).toEqual([]);
    expect(extractHits('  limit_units: number;\n  remaining_units: number;', 'f.tsx')).toEqual([]);
  });

  it('같은 줄에 formatCount가 있으면 그 줄의 다른 필드도 통과한다(줄 단위 판정, 필드별 아님)', () => {
    // 하나만 formatCount로 감싸고 다른 하나는 안 감싼 «부분 처방»까지 잡으려면 필드별
    // 위치 추적이 필요하지만(AST), 이 가드는 줄 단위 grep(verify-no-date-tolocalestring.ts
    // 승계 한계)이라 한 줄에 formatCount가 하나라도 있으면 그 줄 전체가 통과한다 —
    // ⛔이 가드의 알려진 한계로 문서화(모듈 docstring 참고), 실 코드는 두 필드 모두
    // formatCount로 감싸는 것이 정본(page.tsx 실 처방 그대로).
    const hits = extractHits(
      "t('k', { used: formatCount(usage.used_units, locale), limit: usage.limit_units })",
      'f.tsx',
    );
    expect(hits).toEqual([]);
  });

  it('여러 줄에 걸쳐 있으면 줄 번호를 정확히 낸다', () => {
    const content = [
      'const a = 1;',
      'const b = usage.used_units;',
      'const c = 2;',
    ].join('\n');
    expect(extractHits(content, 'f.tsx')).toEqual([{ file: 'f.tsx', line: 2, field: 'used_units' }]);
  });
});

describe('CI/package.json 배선 — 새 가드가 실제로 돈다(story #3808)', () => {
  it('package.json에 verify:no-unformatted-usage-count 스크립트가 등재돼 있다', () => {
    const pkg = readFileSync(path.resolve(SCRIPT_DIR, '../package.json'), 'utf8');
    expect(pkg.includes('"verify:no-unformatted-usage-count"')).toBe(true);
  });

  it('CI workflow에서 이 스크립트를 부른다', () => {
    const ci = readFileSync(path.resolve(SCRIPT_DIR, '../../../.github/workflows/ci.yml'), 'utf8');
    expect(ci.includes('verify:no-unformatted-usage-count')).toBe(true);
  });
});
