import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALLOWED_EXCEPTIONS, scanE2eForNetworkidle } from './verify-e2e-no-networkidle';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'e2e-networkidle-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

describe('scanE2eForNetworkidle — 픽스처', () => {
  it('networkidle 0건 파일 — 위반 0', () => {
    write('clean.spec.ts', `
      test('x', async ({ page }) => {
        await page.goto('/x');
        await page.locator('h1').waitFor({ state: 'visible' });
      });
    `);
    expect(scanE2eForNetworkidle(dir)).toEqual([]);
  });

  it('⭐미등재 파일에 waitForLoadState(networkidle) — unexpected 위반', () => {
    write('new-flaky.spec.ts', `
      test('x', async ({ page }) => {
        await page.goto('/x');
        await page.waitForLoadState('networkidle');
      });
    `);
    const violations = scanE2eForNetworkidle(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('unexpected');
  });

  it('⭐미등재 파일에 waitUntil: networkidle — unexpected 위반', () => {
    write('new-flaky-2.spec.ts', `
      test('x', async ({ page }) => {
        await page.goto('/x', { waitUntil: 'networkidle' });
      });
    `);
    const violations = scanE2eForNetworkidle(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('unexpected');
  });

  it('주석 안 "networkidle" 언급은 대상 밖(설명용)', () => {
    write('commented.spec.ts', `
      // networkidle을 여기서 썼었지만 지금은 안 쓴다
      test('x', async ({ page }) => {
        await page.goto('/x');
        await page.locator('h1').waitFor({ state: 'visible' });
      });
    `);
    expect(scanE2eForNetworkidle(dir)).toEqual([]);
  });

  it('등재 파일이 선언 개수와 정확히 일치하면 통과', () => {
    write('registered.spec.ts', `
      test('x', async ({ page }) => {
        await page.waitForLoadState('networkidle');
      });
    `);
    const result = scanE2eForNetworkidle(dir, [
      { file: 'registered.spec.ts', reason: '테스트 픽스처', count: 1 },
    ]);
    expect(result).toEqual([]);
  });

  it('⭐등재 파일이 선언 개수를 초과하면 count-exceeded', () => {
    write('registered.spec.ts', `
      test('a', async ({ page }) => { await page.waitForLoadState('networkidle'); });
      test('b', async ({ page }) => { await page.waitForLoadState('networkidle'); });
    `);
    const result = scanE2eForNetworkidle(dir, [
      { file: 'registered.spec.ts', reason: '테스트 픽스처', count: 1 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('count-exceeded');
  });

  it('⭐등재 파일이 선언 개수보다 적으면 count-under(하향 갱신 요구)', () => {
    write('registered.spec.ts', `test('x', async ({ page }) => {});`);
    const result = scanE2eForNetworkidle(dir, [
      { file: 'registered.spec.ts', reason: '테스트 픽스처', count: 1 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('count-under');
  });

  it('⭐reason이 빈 문자열인 예외는 exception-invalid(등재 개수와 무관히 항상 위반)', () => {
    write('registered.spec.ts', `
      test('x', async ({ page }) => { await page.waitForLoadState('networkidle'); });
    `);
    const result = scanE2eForNetworkidle(dir, [
      { file: 'registered.spec.ts', reason: '', count: 1 },
    ]);
    expect(result.some((v) => v.kind === 'exception-invalid')).toBe(true);
  });

  it('verify 구조 검증이 실패하면 exception-unverified', () => {
    write('registered.spec.ts', `
      test('x', async ({ page }) => { await page.waitForLoadState('networkidle'); });
    `);
    const result = scanE2eForNetworkidle(dir, [
      {
        file: 'registered.spec.ts',
        reason: '테스트 픽스처',
        count: 1,
        verify: () => ({ ok: false, detail: '일부러 실패' }),
      },
    ]);
    expect(result.some((v) => v.kind === 'exception-unverified')).toBe(true);
  });
});

describe('실 소스(apps/web/e2e) 스캔 — story #4160', () => {
  it('실 e2e 트리 — 위반 0(등재된 예외 2건뿐: contrast-guard 표 0건 + marker-wait 가지 2건, count-pin·구조 검증 통과)', () => {
    expect(scanE2eForNetworkidle()).toEqual([]);
  });

  it('⭐content-post-manager-states.spec.ts — networkidle 0(story #4160 AC1, 8→0)', () => {
    const violations = scanE2eForNetworkidle().filter((v) => v.file === 'content-post-manager-states.spec.ts');
    expect(violations).toEqual([]);
  });

  it('⭐음성 대조 — support/marker-wait.ts 예외 항목을 지우면(ALLOWED_EXCEPTIONS에서 제외) RED', () => {
    const withoutException = ALLOWED_EXCEPTIONS.filter((e) => e.file !== 'support/marker-wait.ts');
    const violations = scanE2eForNetworkidle(undefined, withoutException);
    expect(violations.some((v) => v.file === 'support/marker-wait.ts' && v.kind === 'unexpected')).toBe(true);
  });

  it('⭐contrast-guard.spec.ts는 networkidle 호출 0건(대기 코드는 marker-wait로 옮겨졌고, 이 파일엔 표만 남음) — 호출을 다시 이 파일에 넣으면 count-exceeded', () => {
    const violations = scanE2eForNetworkidle().filter((v) => v.file === 'contrast-guard.spec.ts');
    expect(violations).toEqual([]);
    expect(ALLOWED_EXCEPTIONS.find((e) => e.file === 'contrast-guard.spec.ts')?.count).toBe(0);
  });

  it('⭐음성 대조 — marker-wait.ts의 networkidle 호출이 `if (marker.kind === networkidle)` 블록 «안»에 있을 때만 통과 — 블록이 닫힌 바로 다음 줄도 · else 가지도 · 다른 if도 밖이다(줄 거리가 아니라 중괄호 중첩으로 판정)', () => {
    const exc = ALLOWED_EXCEPTIONS.find((e) => e.file === 'support/marker-wait.ts')!;
    const inBranch = `
      if (marker.kind === 'networkidle') {
        await page.reload();
        await page.waitForLoadState('networkidle', { timeout: 1 });
      }`;
    expect(exc.verify!(inBranch).ok).toBe(true);
    // right after the block closed (one line away)
    expect(exc.verify!(`
      if (marker.kind === 'networkidle') {
        await page.reload();
      }
      await page.waitForLoadState('networkidle', { timeout: 1 });`).ok).toBe(false);
    // the else branch of the same if
    expect(exc.verify!(`
      if (marker.kind === 'networkidle') {
        await page.reload();
      } else {
        await page.waitForLoadState('networkidle', { timeout: 1 });
      }`).ok).toBe(false);
    // inside another if
    expect(exc.verify!(`
      if (marker.kind === 'response') {
        await page.waitForLoadState('networkidle', { timeout: 1 });
      }`).ok).toBe(false);
    // inside a nested block of the right if still counts (the call is inside it)
    expect(exc.verify!(`
      if (marker.kind === 'networkidle') {
        try {
          await page.waitForLoadState('networkidle', { timeout: \`\${1}\` });
        } catch {}
      }`).ok).toBe(true);
    expect(exc.verify!(`await page.waitForLoadState('networkidle');`).ok).toBe(false);
    // and the real file passes
    expect(scanE2eForNetworkidle().filter((v) => v.file === 'support/marker-wait.ts')).toEqual([]);
  });

  it('⭐음성 대조 — 예외 reason을 비우면 RED', () => {
    const blanked = ALLOWED_EXCEPTIONS.map((e) => (e.file === 'contrast-guard.spec.ts' ? { ...e, reason: '' } : e));
    const violations = scanE2eForNetworkidle(undefined, blanked);
    expect(violations.some((v) => v.file === 'contrast-guard.spec.ts' && v.kind === 'exception-invalid')).toBe(true);
  });

  it('⭐음성 대조 — contrast-guard.spec.ts에 /onboarding 아닌 경로용 kind:networkidle 항목을 얹으면 구조 검증 RED', () => {
    const violations = scanE2eForNetworkidle(undefined, ALLOWED_EXCEPTIONS.map((e) => ({
      ...e,
      verify: e.file === 'contrast-guard.spec.ts'
        ? (content: string) => {
          // 실 파일 텍스트에 /dashboard용 kind:'networkidle' 줄이 있다고 가정하고 검증기만 시험
          const mutated = `${content}\n  { path: '/dashboard', label: 'x', wait: { kind: 'networkidle' } },`;
          return e.verify!(mutated);
        }
        : e.verify,
    })));
    expect(violations.some((v) => v.file === 'contrast-guard.spec.ts' && v.kind === 'exception-unverified')).toBe(true);
  });
});
