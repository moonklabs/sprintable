import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ALLOWLIST, ALLOWLIST_MAX, computeUnwired, isAllowlistOverLimit, loadCiWiredScriptNames, loadVerifyScriptNames,
} from './verify-ci-wires-all-verify-scripts';

describe('loadVerifyScriptNames', () => {
  it('extracts only verify:* keys from package.json scripts, in order-independent form', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'meta-guard-pkg-'));
    const file = path.join(dir, 'package.json');
    writeFileSync(file, JSON.stringify({
      scripts: { dev: 'next dev', 'verify:foo': 'tsx x', 'verify:bar': 'tsx y', build: 'next build' },
    }));
    const names = loadVerifyScriptNames(file);
    expect(names).toEqual(new Set(['verify:foo', 'verify:bar']));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('loadCiWiredScriptNames', () => {
  it('extracts verify:* names from `pnpm --filter web verify:X` invocations in ci.yml text', () => {
    const ci = [
      '      - name: "Verify foo"',
      '        run: pnpm --filter web verify:foo',
      '      - name: "Verify bar"',
      '        run: |',
      '          pnpm --filter web verify:bar -- --selftest',
    ].join('\n');
    expect(loadCiWiredScriptNames(ci)).toEqual(new Set(['verify:foo', 'verify:bar']));
  });

  it('does not match a plain `pnpm run verify:X` or other invocation shapes(㉠ 선언된 한계)', () => {
    const ci = '        run: pnpm run verify:foo\n';
    expect(loadCiWiredScriptNames(ci)).toEqual(new Set());
  });
});

describe('computeUnwired — 판정 로직(main()과 같은 심볼)', () => {
  it('returns scripts present in package.json but absent from ci.yml wiring', () => {
    const scripts = new Set(['verify:a', 'verify:b', 'verify:c']);
    const wired = new Set(['verify:a', 'verify:c']);
    expect(computeUnwired(scripts, wired, {})).toEqual(['verify:b']);
  });

  it('returns empty when every script is wired', () => {
    const scripts = new Set(['verify:a', 'verify:b']);
    const wired = new Set(['verify:a', 'verify:b']);
    expect(computeUnwired(scripts, wired, {})).toEqual([]);
  });

  it('excludes ALLOWLIST-registered scripts from the unwired result(의도적 제외)', () => {
    const scripts = new Set(['verify:a', 'verify:b']);
    const wired = new Set(['verify:a']);
    expect(computeUnwired(scripts, wired, { 'verify:b': '의도적 제외 — 사유' })).toEqual([]);
  });

  it('sorts the result for stable output', () => {
    const scripts = new Set(['verify:zzz', 'verify:aaa']);
    const wired = new Set<string>();
    expect(computeUnwired(scripts, wired, {})).toEqual(['verify:aaa', 'verify:zzz']);
  });
});

// story #3739 — 양성대조: 가짜 verify:zzz를 package.json에 추가했는데 ci.yml에 안 물려
// 있으면 실제로 unwired 목록에 잡힌다는 것을 computeUnwired() 자체로 실증한다(main()이
// 부르는 그 함수 — 페드루 PO 리뷰 관례, story #3164 PR#3580).
describe('양성대조 — verify:zzz(합성)가 실제로 FAIL 대상이 된다', () => {
  it('package.json에 있고 ci.yml에 없는 verify:zzz는 unwired로 잡힌다', () => {
    const scripts = loadVerifyScriptNames(path.resolve(__dirname, '../package.json'));
    scripts.add('verify:zzz');
    const ci = readFileSync(path.resolve(__dirname, '../../../.github/workflows/ci.yml'), 'utf8');
    const wired = loadCiWiredScriptNames(ci);
    const unwired = computeUnwired(scripts, wired, {});
    expect(unwired).toContain('verify:zzz');
  });
});

// story #3739 실 저장소 확認 — 지금 이 커밋의 package.json/ci.yml이 실제로 서로 부분집합
// 관계인지(전건 배선 완료) 값으로 pin한다. 값 자체를 하드코딩하지 않고 «차집합 0»만 잰다
// (실 스크립트 개수가 늘거나 줄어도 이 테스트는 안 흔들린다).
describe('실 저장소 — package.json verify:* ⊆ ci.yml 배선', () => {
  it('현재 커밋 기준 unwired 스크립트가 0개다', () => {
    const scripts = loadVerifyScriptNames(path.resolve(__dirname, '../package.json'));
    const ci = readFileSync(path.resolve(__dirname, '../../../.github/workflows/ci.yml'), 'utf8');
    const wired = loadCiWiredScriptNames(ci);
    expect(computeUnwired(scripts, wired, {})).toEqual([]);
  });
});

// story #3739 — 페드루 PO 리뷰(10:23Z) 지적: ALLOWLIST가 "count-pin(늘어나면 FAIL)"이라
// 약속하는데 그 크기를 실제로 재는 자가 없으면 다음 사람이 항목을 몰래 늘려도 초록이다.
// isAllowlistOverLimit()가 main()이 부르는 그 심볼임을 값으로 확認하고, 양성대조로
// 실제 ALLOWLIST에 항목 하나를 (합성으로) 추가하면 RED가 뜨는지까지 잰다.
describe('isAllowlistOverLimit — ALLOWLIST count-pin(페드루 PO 리뷰 10:23Z)', () => {
  it('빈 ALLOWLIST·상한 0이면 초과가 아니다', () => {
    expect(isAllowlistOverLimit({}, 0)).toBe(false);
  });

  it('항목 1개·상한 0이면 초과다', () => {
    expect(isAllowlistOverLimit({ 'verify:foo': '사유' }, 0)).toBe(true);
  });

  it('항목 수가 상한과 같으면 초과가 아니다(경계값)', () => {
    expect(isAllowlistOverLimit({ 'verify:foo': '사유' }, 1)).toBe(false);
  });

  // 양성대조 — 실 ALLOWLIST_MAX(지금 0)를 실 ALLOWLIST에 합성 항목 하나를 더해
  // 재본다. 이 값이 실제로 RED로 갈리는지 확認(뮤테이션 표적: isAllowlistOverLimit
  // 자체를 항상 false로 바꿔치기하면 이 테스트가 잡는다).
  it('실 ALLOWLIST에 합성 항목 하나를 더하면 실 ALLOWLIST_MAX 기준으로 초과가 된다', () => {
    const mutated = { ...ALLOWLIST, 'verify:zzz-synthetic': '양성대조용 합성 항목' };
    expect(isAllowlistOverLimit(mutated, ALLOWLIST_MAX)).toBe(true);
  });

  it('실 ALLOWLIST는 지금 실 ALLOWLIST_MAX를 넘지 않는다(현재 상태 pin)', () => {
    expect(isAllowlistOverLimit(ALLOWLIST, ALLOWLIST_MAX)).toBe(false);
  });
});
