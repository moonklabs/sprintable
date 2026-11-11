// @vitest-environment jsdom
// UI-3(a9d56577) `touch:` 변형 회귀가드 — 44 바닥이 «손가락 기기»에서 실제로 걸리는가.
// jsdom은 미디어 쿼리를 안 돌린다 → ds 부품이 실제로 쓰는 클래스를 Tailwind로 «컴파일»하고(변형 정의는 design-system.css 소스에서 그대로 꺼낸다),
// 컴파일된 CSS를 기기 꼴별로 읽어 누름 높이(height · min-height)를 계산한다. 변형 정의를 되돌리거나 부품이 다시 pointer-coarse만 쓰면 빨개진다.
import { beforeAll, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { buildProbe, spacingTokenPx, variantBlock, winning, type Env, type Probe } from '@/lib/compiled-css-probe.test-helper';
import { Button } from './button';
import { IconButton } from './icon-button';
import { Input } from './input';
import { NativeSelect } from './select';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE_PROPS = ['height', 'min-height', 'width', 'min-width'];
const SPACING_PX = 4; // @theme { --spacing: 0.25rem }
function px(value: string): number {
  const tok = /^var\(--spacing-(ds-[a-z-]+)\)$/.exec(value);
  if (tok) return spacingTokenPx(tok[1]!);
  const m = /^calc\(var\(--spacing\)\s*\*\s*(\d+(?:\.\d+)?)\)$/.exec(value);
  if (!m) throw new Error(`시험이 모르는 값: ${value}`);
  return Number(m[1]) * SPACING_PX;
}
/** 누름 크기 = max(size, min-size) (기기 꼴별로 컴파일된 CSS에서 이기는 값). */
function press(classes: string, probe: Probe, env: Env, axis: 'height' | 'width'): number {
  const a = winning(probe, classes, axis, env);
  const b = winning(probe, classes, `min-${axis}`, env);
  return Math.max(a ? px(a) : 0, b ? px(b) : 0);
}
const pressHeight = (classes: string, probe: Probe, env: Env) => press(classes, probe, env, 'height');
const pressWidth = (classes: string, probe: Probe, env: Env) => press(classes, probe, env, 'width');

// ─── ds 부품이 실제로 내는 클래스 ──────────────────────────────────────────────
let index: Probe;
let parts: Record<string, string>;
beforeAll(async () => {
  // 부품 클래스를 먼저 모은 뒤 한 번에 컴파일한다.
  const host = document.createElement('div');
  document.body.appendChild(host);
  const r = createRoot(host);
  const grab = async (node: ReactNode, selector: string) => {
    await act(async () => { r.render(node); });
    return (host.querySelector(selector) as HTMLElement).className;
  };
  parts = {
    'Button(md)': await grab(<Button>확인</Button>, '[data-slot="ds-button"]'),
    'Button(lg)': await grab(<Button size="lg">확인</Button>, '[data-slot="ds-button"]'),
    IconButton: await grab(<IconButton icon="close" label="닫기" />, '[data-slot="ds-icon-button"]'),
    Input: await grab(<Input aria-label="이름" />, '[data-slot="ds-input"]'),
    NativeSelect: await grab(<NativeSelect aria-label="역할"><option>x</option></NativeSelect>, 'select'),
  };
  await act(async () => { r.unmount(); });
  host.remove();
  const all = new Set(Object.values(parts).flatMap((c) => c.split(/\s+/)));
  index = await buildProbe([...all], ['touch'], SIZE_PROPS);
});

const DESKTOP: Env = { pointer: 'fine', hover: 'hover' }; // 데스크톱 마우스
const EMULATOR: Env = { pointer: 'fine', hover: 'none' }; // 안드로이드 에뮬 웹뷰 · S펜류 — 민군 실측 꼴
const PHONE: Env = { pointer: 'coarse', hover: 'none' }; // 보통 폰 · 태블릿(iOS)
const TABLET_PEN: Env = { pointer: 'coarse', hover: 'hover' }; // coarse만 참인 꼴
const APP_ANDROID: Env = { pointer: 'fine', hover: 'hover', shell: 'android' }; // 스타일러스 폰이 앱 안에서 마우스로 읽히는 꼴 — 앱 셸 표지가 건다
const APP_IOS: Env = { pointer: 'fine', hover: 'hover', shell: 'ios' };
const APP_MAC: Env = { pointer: 'fine', hover: 'hover', shell: 'macos' }; // 맥 데스크톱 앱 = 마우스 → 36

describe('touch: 변형 — 44 바닥', () => {
  it('⭐데스크톱(fine + hover)은 그대로: Button 28/36 · Input 36 · NativeSelect 36', () => {
    expect(pressHeight(parts['Button(md)']!, index, DESKTOP)).toBe(28);
    expect(pressHeight(parts['Button(lg)']!, index, DESKTOP)).toBe(36);
    expect(pressHeight(parts.Input!, index, DESKTOP)).toBe(36);
    expect(pressHeight(parts.NativeSelect!, index, DESKTOP)).toBe(36);
  });

  it('⭐에뮬 꼴(fine + hover none)에서도 44 — pointer-coarse만 쓰던 때 빠지던 자리', () => {
    for (const [name, cls] of Object.entries(parts)) expect(pressHeight(cls, index, EMULATOR), name).toBe(44);
  });

  it('⭐보통 폰(coarse + hover none)과 coarse만 참인 꼴도 44', () => {
    for (const env of [PHONE, TABLET_PEN]) for (const [name, cls] of Object.entries(parts)) expect(pressHeight(cls, index, env), name).toBe(44);
  });

  it('⭐앱 셸 안(ios · android)은 기기 분류가 «마우스»여도 44, 맥 앱(macos)은 36 그대로', () => {
    for (const env of [APP_ANDROID, APP_IOS]) for (const [name, cls] of Object.entries(parts)) expect(pressHeight(cls, index, env), name).toBe(44);
    expect(pressHeight(parts.Input!, index, APP_MAC)).toBe(36);
    expect(pressHeight(parts.NativeSelect!, index, APP_MAC)).toBe(36);
    expect(pressHeight(parts['Button(md)']!, index, APP_MAC)).toBe(28);
  });

  it('⭐누르는 부품(Button · IconButton)은 가로도 44 — 에뮬 · 앱 셸 꼴에서도, 데스크톱은 44 아래', () => {
    for (const name of ['Button(md)', 'Button(lg)', 'IconButton']) {
      const cls = parts[name]!;
      for (const env of [EMULATOR, PHONE, APP_ANDROID, APP_IOS]) expect(pressWidth(cls, index, env), `${name} ${JSON.stringify(env)}`).toBe(44);
      expect(pressWidth(cls, index, DESKTOP), name).toBeLessThan(44);
      expect(pressWidth(cls, index, APP_MAC), name).toBeLessThan(44);
    }
    expect(pressHeight(parts.IconButton!, index, DESKTOP)).toBe(28);
  });

  it('ds 부품은 pointer-coarse:를 더 쓰지 않는다(쓰면 에뮬 꼴에서 44가 빠진다)', () => {
    for (const [name, cls] of Object.entries(parts)) expect(cls, name).not.toContain('pointer-coarse:');
  });

  it('변형 정의: media 둘 «또는» — pointer: coarse · hover: none', () => {
    const b = variantBlock('touch');
    expect(b).toContain('(pointer: coarse)');
    expect(b).toContain('(hover: none)');
  });
});
