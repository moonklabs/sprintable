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

  // story 4831 — 글자 눈금의 빈 두 단(micro 10px · display 32px)도 같은 처방 대상이다. 등록이 빠지면 text-color로 오분류돼 앞의 글자색이 조용히 지워진다.
  it('⭐새 글자 단 text-micro · text-display가 text-color와 공존한다', () => {
    expect(cn('text-muted-foreground', 'text-micro')).toBe('text-muted-foreground text-micro');
    expect(cn('text-foreground', 'text-display')).toBe('text-foreground text-display');
    expect(cn('text-micro', 'text-muted-foreground')).toBe('text-micro text-muted-foreground');
  });

  it('새 글자 단끼리 · 기존 크기와는 크기 축으로 충돌한다(뒤가 이김)', () => {
    expect(cn('text-micro', 'text-display')).toBe('text-display');
    expect(cn('text-sm', 'text-micro')).toBe('text-micro');
    expect(cn('text-display', 'text-editorial-meta')).toBe('text-editorial-meta');
  });

  it('같은 축끼리는 여전히 충돌한다(뒤가 이김 — 회귀 방지 처방이 충돌 판정 자체를 무력화하지 않았는지)', () => {
    expect(cn('font-editorial-heading', 'font-bold')).toBe('font-bold');
    expect(cn('font-sans', 'font-serif')).toBe('font-serif');
    expect(cn('text-lg', 'text-editorial-body')).toBe('text-editorial-body');
    expect(cn('text-editorial-body', 'text-editorial-ui')).toBe('text-editorial-ui');
  });
});

// UI-3(a9d56577) — 새 글자 눈금(text-ds-*)도 크기 축으로 등록돼 있어야 글자색(text-ds-ink 등)과 공존한다.
describe('cn() — ds 글자 눈금이 text-color와 공존한다', () => {
  it('text-ds-small · text-ds-title 등이 text-ds-ink / text-muted-foreground를 안 지운다', () => {
    expect(cn('text-ds-ink', 'text-ds-small')).toBe('text-ds-ink text-ds-small');
    expect(cn('text-ds-title', 'text-ds-ink-2')).toBe('text-ds-title text-ds-ink-2');
    expect(cn('text-muted-foreground', 'text-ds-mono-md')).toBe('text-muted-foreground text-ds-mono-md');
  });

  it('ds 글자 단끼리는 크기 축으로 충돌한다(뒤가 이김)', () => {
    expect(cn('text-ds-small', 'text-ds-body')).toBe('text-ds-body');
  });
});

// UI-3(a9d56577) 밀도 · 그림자 · 움직임 토큰(design-system.css `@theme`)이 cn()에서 «올바른 충돌군»에 든다.
// 안 알리면 `h-ds-control`을 호출부의 `h-8`이 못 덮거나(둘 다 남음) 다른 축의 클래스를 지운다.
describe('cn() — ds 밀도 · 그림자 · 움직임 토큰(UI-3)', () => {
  it('⭐밀도: 같은 축끼리는 뒤가 이기고(높이 · 최소 높이 · 정사각), 다른 축과는 공존한다', () => {
    expect(cn('h-ds-control', 'h-8')).toBe('h-8');
    expect(cn('h-8', 'h-ds-control')).toBe('h-ds-control');
    expect(cn('h-ds-control touch:h-ds-touch', 'h-8')).toBe('touch:h-ds-touch h-8');
    expect(cn('min-h-ds-compact', 'min-h-0')).toBe('min-h-0');
    expect(cn('size-ds-control-sm', 'size-10')).toBe('size-10');
    expect(cn('h-ds-control', 'min-h-ds-touch')).toBe('h-ds-control min-h-ds-touch');
    expect(cn('touch:min-h-ds-touch', 'touch:min-h-0')).toBe('touch:min-h-0');
    expect(cn('touch:h-ds-touch', 'touch:h-11')).toBe('touch:h-11');
  });

  it('⭐그림자: ds 그림자끼리 · 기본 그림자와는 충돌하고, 글자색 · 테두리색과는 공존한다', () => {
    expect(cn('shadow-ds-popup', 'shadow-none')).toBe('shadow-none');
    expect(cn('shadow-ds-popup', 'shadow-ds-overlay')).toBe('shadow-ds-overlay');
    expect(cn('shadow-md', 'shadow-ds-popup')).toBe('shadow-ds-popup');
    expect(cn('shadow-ds-popup', 'text-ds-ink', 'border-ds-line')).toBe('shadow-ds-popup text-ds-ink border-ds-line');
  });

  it('⭐움직임: animate-ds-pulse는 다른 animate와 충돌하고 transition과 공존한다', () => {
    expect(cn('animate-ds-pulse', 'animate-none')).toBe('animate-none');
    expect(cn('animate-ds-pulse', 'transition-colors')).toBe('animate-ds-pulse transition-colors');
    expect(cn('duration-(--ds-duration-fast)', 'duration-300')).toBe('duration-300');
  });
});
