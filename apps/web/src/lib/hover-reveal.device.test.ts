// @vitest-environment jsdom
// UI-3(a9d56577) HOVER_REVEAL 기기 꼴 회귀가드 — 호버로만 드러나는 조작 요소가 «정말 마우스 올림이 되는 곳»에서만 숨는가.
// 실제 HOVER_REVEAL 클래스를 Tailwind로 컴파일하고(변형 정의는 design-system.css 소스에서 그대로) 기기 꼴 · 행 상태별로 opacity를 판정한다.
// 예전(`pointer-fine:` 하나)에는 에뮬 웹뷰 · 스타일러스 폰(pointer fine + hover none)과 앱 셸 안에서 «⋮» 같은 단추가 숨은 채 영영 안 드러났다.
import { beforeAll, describe, expect, it } from 'vitest';
import { HOVER_REVEAL } from './hover-reveal';
import { buildProbe, winning, type Env, type Probe } from './compiled-css-probe.test-helper';

let probe: Probe;
beforeAll(async () => {
  probe = await buildProbe(HOVER_REVEAL.split(/\s+/), ['mouse'], ['opacity']);
});
const opacity = (env: Env) => winning(probe, HOVER_REVEAL, 'opacity', env);

const DESKTOP: Env = { pointer: 'fine', hover: 'hover' };
const EMULATOR: Env = { pointer: 'fine', hover: 'none' }; // 안드로이드 에뮬 웹뷰 · S펜류 — 민군 실측 꼴
const PHONE: Env = { pointer: 'coarse', hover: 'none' };
const COARSE_HOVER: Env = { pointer: 'coarse', hover: 'hover' };
const APP_ANDROID: Env = { pointer: 'fine', hover: 'hover', shell: 'android' }; // 앱 안 블루투스 마우스 — 앱 안은 기기 분류에 안 기댄다(PO)
const APP_IOS: Env = { pointer: 'fine', hover: 'hover', shell: 'ios' };
const APP_MAC: Env = { pointer: 'fine', hover: 'hover', shell: 'macos' }; // 맥 데스크톱 앱 = 마우스

describe('HOVER_REVEAL — 어디서 숨고 어디서 늘 보이나', () => {
  it('⭐데스크톱 마우스(fine + hover)와 맥 앱(macos)은 평소 숨는다', () => {
    expect(opacity(DESKTOP)).toBe('0%');
    expect(opacity(APP_MAC)).toBe('0%');
  });

  it('⭐올릴 마우스가 없는 곳은 늘 보인다 — 에뮬 꼴(fine + hover none) · 폰 · coarse만 참 · 앱 셸 안드로이드 · iOS', () => {
    for (const [name, env] of Object.entries({ EMULATOR, PHONE, COARSE_HOVER, APP_ANDROID, APP_IOS })) expect(opacity(env), name).toBe('100%');
  });

  it('⭐데스크톱에서 행에 올리거나 · 행 안에 초점이 있거나 · 요소 자신이 초점을 쥐면 드러난다', () => {
    expect(opacity({ ...DESKTOP, rowHover: true })).toBe('100%');
    expect(opacity({ ...DESKTOP, rowFocus: true })).toBe('100%');
    expect(opacity({ ...DESKTOP, selfFocus: true })).toBe('100%');
    expect(opacity({ ...APP_MAC, rowHover: true })).toBe('100%');
    expect(opacity({ ...APP_MAC, selfFocus: true })).toBe('100%');
  });

  it('숨김은 display · visibility가 아니라 opacity만이다(탭 순서에서 안 빠진다)', () => {
    expect(HOVER_REVEAL).not.toMatch(/(^|\s)(hidden|invisible)(\s|$)/);
    expect(HOVER_REVEAL).not.toContain('pointer-fine:');
  });
});
