// story #2976 — tailwind-merge 커스텀 테마 충돌군 회귀가드.
//
// twMerge는 프로젝트의 실제 Tailwind 설정을 읽지 않고 표준 테마 값(굵기는 thin~black,
// 크기는 xs~9xl 등) 이름만 기본 내장한다. globals.css `@theme inline`이 정의한 커스텀
// 테마 키(`--font-weight-editorial-*`·`--text-editorial-*`)는 그 목록에 없어, 같은
// `font-`/`text-` 접두를 공유하는 다른 충돌군(font-family·text-color)의 더 관대한
// arbitrary-name 매처가 먼저 먹혀 뒤 클래스가 앞을 조용히 지운다(PR#3406 페이지헤더
// 인라인 style 우회의 원인 — text-color 축도 동일 패턴, 이 그라운딩에서 신규 확인).
// `cn()`(lib/utils.ts)을 `extendTailwindMerge`로 교체해 정확한 충돌군에 등록했다 —
// 이 파일은 그 처방이 실제로 두 축(family+weight·color+size) 모두에서 동작하고, 같은
// 축끼리(weight+weight·size+size)는 여전히 올바르게 충돌하는지 고정한다.
import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn() — 커스텀 font-weight/text 테마 값이 다른 축과 병기될 때 안 지워진다(#2976)', () => {
  it('font-weight(font-editorial-heading)가 font-family(font-display/font-heading)와 공존한다', () => {
    expect(cn('font-heading', 'font-editorial-heading')).toBe('font-heading font-editorial-heading');
    expect(cn('font-display', 'font-editorial-heading')).toBe('font-display font-editorial-heading');
    // 순서를 뒤집어도(가장 취약했던 방향) 동일 — 과거엔 순서에 따라 둘 중 하나가 사라졌다.
    expect(cn('font-editorial-heading', 'font-display')).toBe('font-editorial-heading font-display');
  });

  it('font-size(text-editorial-*)가 text-color와 공존한다', () => {
    expect(cn('text-red-500', 'text-editorial-body')).toBe('text-red-500 text-editorial-body');
    expect(cn('text-muted-foreground', 'text-editorial-ui')).toBe('text-muted-foreground text-editorial-ui');
    expect(cn('text-editorial-claim', 'text-foreground')).toBe('text-editorial-claim text-foreground');
  });

  it('같은 축끼리는 여전히 충돌한다(뒤가 이김 — 회귀 방지 처방이 충돌 판정 자체를 무력화하지 않았는지)', () => {
    expect(cn('font-editorial-heading', 'font-bold')).toBe('font-bold');
    expect(cn('font-sans', 'font-serif')).toBe('font-serif');
    expect(cn('text-lg', 'text-editorial-body')).toBe('text-editorial-body');
    expect(cn('text-editorial-body', 'text-editorial-ui')).toBe('text-editorial-ui');
  });
});
