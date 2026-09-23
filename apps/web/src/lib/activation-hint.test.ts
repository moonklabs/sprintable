// @vitest-environment jsdom
// story #4219 F1 — 표시용 힌트 쿠키. org 하나 값 · org가 다르거나 모양이 틀리면 «없음» · Path=/ · SameSite=Lax · 만료 있음.
// ⛔권한·데이터 판단 금지 — 이 모듈의 소비처는 (authenticated) 레이아웃의 체크리스트 대기 여부와 배너 표시뿐(아래 핀).
import { afterEach, describe, expect, it } from 'vitest';
import { ACTIVATION_HINT_COOKIE, ACTIVATION_HINT_MAX_AGE_SECONDS, formatActivationHint, parseActivationHint, writeActivationHint } from './activation-hint';

afterEach(() => { document.cookie = `${ACTIVATION_HINT_COOKIE}=; Path=/; Max-Age=0`; });

describe('parseActivationHint', () => {
  it('같은 org → 힌트 · 다른 org·모양 틀림·빈 값 → 없음', () => {
    expect(parseActivationHint(formatActivationHint('org-1', true), 'org-1')).toBe('complete');
    expect(parseActivationHint(formatActivationHint('org-1', false), 'org-1')).toBe('incomplete');
    expect(parseActivationHint('org-1:complete', 'org-2')).toBeUndefined();
    expect(parseActivationHint('org-1:maybe', 'org-1')).toBeUndefined();
    expect(parseActivationHint('complete', 'org-1')).toBeUndefined();
    expect(parseActivationHint(undefined, 'org-1')).toBeUndefined();
    expect(parseActivationHint('org-1:complete', undefined)).toBeUndefined();
  });
});

describe('writeActivationHint', () => {
  it('쓴 값을 같은 org로 다시 읽으면 같은 힌트 · 만료는 유한', () => {
    writeActivationHint('org-1', true);
    const raw = document.cookie.split('; ').find((c) => c.startsWith(`${ACTIVATION_HINT_COOKIE}=`))!.split('=')[1]!;
    expect(parseActivationHint(decodeURIComponent(raw), 'org-1')).toBe('complete');
    expect(ACTIVATION_HINT_MAX_AGE_SECONDS).toBeGreaterThan(0);
    expect(ACTIVATION_HINT_MAX_AGE_SECONDS).toBeLessThanOrEqual(60 * 60 * 24 * 30);
  });

  it('쿠키 속성: Path=/ · SameSite=Lax · Max-Age', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, 'activation-hint.ts'), 'utf8');
    expect(src).toMatch(/Path=\/; Max-Age=\$\{ACTIVATION_HINT_MAX_AGE_SECONDS\}; SameSite=Lax/);
  });

  it('⛔소비처 핀 — 표시용 힌트는 레이아웃(체크리스트 대기 여부)과 배너(기록)에서만 쓴다', async () => {
    const { execSync } = await import('node:child_process');
    const { join } = await import('node:path');
    const srcRoot = join(__dirname, '..');
    const users = execSync(`grep -rl "activation-hint'" ${JSON.stringify(srcRoot)} --include=*.ts --include=*.tsx`, { encoding: 'utf8' })
      .trim().split('\n').map((f) => f.slice(srcRoot.length + 1)).filter((f) => !f.includes('.test.')).sort();
    expect(users).toEqual(['app/(authenticated)/layout.tsx', 'components/dashboard/activation-checklist-banner.tsx']);
  });
});
