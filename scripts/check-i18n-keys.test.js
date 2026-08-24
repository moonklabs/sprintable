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

  // story #3023(카디르 QA #3445 근본추적) — 정규식 리터럴 안의 백틱(짝이 안 맞는 홀수 개)을
  // backtick 분기가 문자열 델리미터로 오인해, 그 뒤 남은 파일 전체가 "닫히지 않은 문자열
  // 안"으로 착각되던 결함. story-detail-panel.tsx L144(INLINE_CODE_SPAN_RE) 실제 레포 라인
  // 그대로 재현.
  describe('regex 리터럴 안의 백틱 — 정규식 리터럴을 문자열로 오인해 이후 주석 인식이 깨지지 않는다', () => {
    it('짝이 안 맞는(홀수 개) 백틱을 담은 정규식 리터럴 뒤의 진짜 //주석이 여전히 스트립된다', () => {
      // 원 repro(story-detail-panel.tsx L143-144 그대로): 이 두 정규식 정의가 있으면
      // 예전 코드는 이 지점부터 "문자열 안"으로 착각해 뒤이은 실 주석을 못 걷었다.
      const src = [
        'const FENCED_CODE_BLOCK_RE = /```[\\s\\S]*?```/g;',
        'const INLINE_CODE_SPAN_RE = /`[^`\\n]*`/g;',
        '',
        "// t('workcellDodMissing') 은 예시일 뿐 실호출 아님",
        "const t2 = useTranslations('workcell');",
      ].join('\n');
      const stripped = stripComments(src);
      expect(stripped).not.toContain("t('workcellDodMissing')");
      expect(stripped).toContain("useTranslations('workcell')");
    });

    it('정규식 리터럴 자체의 내용(백틱 포함)은 그대로 보존한다(verbatim — 정규식 훼손 없음)', () => {
      const src = 'const RE = /`[^`\\n]*`/g;';
      expect(stripComments(src)).toBe(src);
    });

    it('JSX 닫는 태그(</div> 등 "/" 문자)가 정규식으로 오인돼 뒤 내용을 삼키지 않는다(회귀 0)', () => {
      // 한 줄에 "/" 가 여럿(자체닫힘·닫는태그) 있어도 JSX는 정규식 판별 문맥(직전이
      // "="/"("/"," 등)에 안 걸려야 한다 — 아니면 JSX가 흔한 .tsx 전체에 새 오탐이 생긴다.
      const src = '<span>a</span> <b>c</b>\n// real comment after jsx\nconst t = useTranslations("foo");';
      const stripped = stripComments(src);
      expect(stripped).toContain('<span>a</span> <b>c</b>');
      expect(stripped).not.toContain('// real comment after jsx');
      expect(stripped).toContain('useTranslations("foo")');
    });

    it('나눗셈(division)은 여전히 정규식으로 오인되지 않는다(회귀 0)', () => {
      const src = 'const half = total / 2; // 주석';
      const stripped = stripComments(src);
      expect(stripped).toContain('total / 2');
      expect(stripped).not.toContain('주석');
    });
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
