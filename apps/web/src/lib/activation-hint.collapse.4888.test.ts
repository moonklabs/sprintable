// @vitest-environment jsdom
// story #4888(UI-5, AC3 §4-5) — 시작 체크리스트 배너는 **기본이 접힘**이다(예전: 폰 390 첫 화면에 234px 띠가 서서 화면을 가렸다). 접힘 쿠키의 뜻: 저장된 «열어 둔 org»가 없으면 접힘.
import { afterEach, describe, expect, it } from 'vitest';
import { ACTIVATION_COLLAPSED_COOKIE, isActivationCollapsed, writeActivationCollapsed } from './activation-hint';

afterEach(() => { document.cookie = `${ACTIVATION_COLLAPSED_COOKIE}=; Path=/; Max-Age=0`; });
const raw = () => decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith(`${ACTIVATION_COLLAPSED_COOKIE}=`)) ?? '').split('=').slice(1).join('='));

describe('isActivationCollapsed — 기본 접힘', () => {
  it('⭐저장된 선택이 없으면 접힘(기본)', () => {
    expect(isActivationCollapsed(undefined, 'org-1')).toBe(true);
    expect(isActivationCollapsed('', 'org-1')).toBe(true);
    expect(isActivationCollapsed(null, 'org-1')).toBe(true);
  });
  it('⭐이 org를 «열어 둔 org»로 기억했으면 펼침', () => {
    expect(isActivationCollapsed('open:org-1', 'org-1')).toBe(false);
  });
  it('⭐다른 org를 열어 둔 것이면 이 org는 접힘(다른 org의 선택이 새지 않는다)', () => {
    expect(isActivationCollapsed('open:org-2', 'org-1')).toBe(true);
  });
  it('org를 모르면(범위 없음) 접힘이라고 말하지 않는다 — 예전과 같다', () => {
    expect(isActivationCollapsed(undefined, undefined)).toBe(false);
    expect(isActivationCollapsed('open:org-1', null)).toBe(false);
  });
});

describe('writeActivationCollapsed', () => {
  it('⭐펼치면 `open:<org>`를 세션 쿠키로 남긴다(Max-Age 없음) · 접으면 쿠키를 지운다(접힘 = 기본)', () => {
    writeActivationCollapsed('org-1', false);
    expect(raw()).toBe('open:org-1');
    writeActivationCollapsed('org-1', true);
    expect(raw()).toBe('');
  });
  it('⭐쓴 값을 레이아웃이 읽는 함수로 다시 읽으면 같은 뜻이다(펼침 → 펼침 · 접힘 → 접힘)', () => {
    writeActivationCollapsed('org-1', false);
    expect(isActivationCollapsed(raw(), 'org-1')).toBe(false);
    writeActivationCollapsed('org-1', true);
    expect(isActivationCollapsed(raw(), 'org-1')).toBe(true);
  });
});
