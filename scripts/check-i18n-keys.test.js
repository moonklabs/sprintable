// story #2371 — check-i18n-keys.js의 순수함수 회귀가드. main()은 require해도 안 돈다
// (require.main === module 가드) — 그래서 이 테스트는 파일 I/O나 process.exit 부작용 없이
// flatten/stripComments/isDynamicallyComposed만 직접 잰다.
import { describe, expect, it } from 'vitest';
import { flatten, stripComments, isDynamicallyComposed, DYNAMIC_KEY_PREFIXES } from './check-i18n-keys.js';

describe('flatten — ㉢ 2단 이상 중첩 dot-path 평탄화', () => {
  it('flattens arbitrarily deep nesting into dot-joined leaf paths', () => {
    const out = flatten({ a: { b: { c: 'leaf' } }, top: 'x' });
    expect(out).toEqual({ 'a.b.c': 'leaf', top: 'x' });
  });

  it('does not descend into arrays — arrays are treated as leaf values', () => {
    const out = flatten({ a: ['x', 'y'] });
    expect(out).toEqual({ a: ['x', 'y'] });
  });
});

describe('stripComments — ㉤ 주석 안 예시코드를 실호출로 오인하는 것 방지', () => {
  it('removes // line comments', () => {
    expect(stripComments("const x = 1; // t('title')\n")).toBe('const x = 1; \n');
  });

  it('removes /* block */ comments including across newlines', () => {
    expect(stripComments("/* t('title')\nold call */\nconst y = 2;")).toBe('\nconst y = 2;');
  });

  it('preserves string literal contents (does not eat // inside a string)', () => {
    const src = "const url = 'https://example.com';";
    expect(stripComments(src)).toBe(src);
  });

  it('preserves template literal contents including ${} interpolation', () => {
    const src = 'const k = `status_${s}`;';
    expect(stripComments(src)).toBe(src);
  });

  it('regression: a comment citing an old call as history (inbox/page.tsx:188 shape) is stripped, not counted as a real call', () => {
    const src = "// t('title')(\"제목\") 이제 안 씀\nconst t2 = useTranslations('inbox');";
    const stripped = stripComments(src);
    expect(stripped).not.toContain("t('title')");
    expect(stripped).toContain("useTranslations('inbox')");
  });
});

describe('isDynamicallyComposed — AC4 화이트리스트, AC5 양성대조', () => {
  // 유나 표본(#2756) — 실제 messages에 존재하는 살아있는 동적 조합 키. 화이트리스트가 이들을
  // dead 후보에서 빼지 못하면(=false라고 답하면) 실사용 키가 삭제 후보로 잘못 뜬다.
  it.each([
    'settings.notificationLevel_all',
    'standup.reviewType_approve',
    'canvas.galleryAxisEpic',
    'recruiter.kitOrientingWakeBody_channel-plugin',
  ])('%s는 화이트리스트에 걸려 dead 후보에서 빠진다', (key) => {
    expect(isDynamicallyComposed(key)).toBe(true);
  });

  it('a plain unrelated key is NOT exempted (whitelist must be able to fail — the other half of AC5)', () => {
    expect(isDynamicallyComposed('settings.title')).toBe(false);
    expect(isDynamicallyComposed('goals.newGoal')).toBe(false);
  });

  it('matches only at a path-segment boundary, not as an arbitrary substring', () => {
    // "actor_" 화이트리스트가 있어도 그 앞에 임의 문자가 붙어 «비-경계» 위치에서 우연히
    // 걸리면 안 된다(과잉면제 방지) — 세그먼트 시작(`^`나 직전 `.`)에서만 매치해야 한다.
    expect(isDynamicallyComposed('settings.xactor_foo')).toBe(false);
    expect(isDynamicallyComposed('settings.actor_foo')).toBe(true);
  });

  it('DYNAMIC_KEY_PREFIXES entries all carry a file + reason (no bare additions)', () => {
    for (const entry of DYNAMIC_KEY_PREFIXES) {
      expect(entry.file, `${entry.prefix} missing file`).toBeTruthy();
      expect(entry.reason, `${entry.prefix} missing reason`).toBeTruthy();
    }
  });
});
