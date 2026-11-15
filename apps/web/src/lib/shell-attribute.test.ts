// @vitest-environment jsdom
// UI-3(a9d56577) 앱 셸 표지 — 전역 ios/android → <html data-sprintable-shell> 붙음 · macos/없음/엉뚱한 값 → 안 붙음 · 루트 layout head 맨 앞에 실림 · CSP가 인라인을 막지 않음.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SHELL_ATTRIBUTE, SHELL_ATTRIBUTE_SCRIPT } from './shell-attribute';

type ShellWindow = { __SPRINTABLE_SHELL__?: unknown };
const w = window as unknown as ShellWindow;

function run() {
  document.documentElement.removeAttribute(SHELL_ATTRIBUTE);
  // 인라인 스크립트를 그대로 실행한다(브라우저가 하는 일).
  new Function(SHELL_ATTRIBUTE_SCRIPT)();
  return document.documentElement.getAttribute(SHELL_ATTRIBUTE);
}
afterEach(() => {
  delete w.__SPRINTABLE_SHELL__;
  document.documentElement.removeAttribute(SHELL_ATTRIBUTE);
});

describe('앱 셸 표지(data-sprintable-shell)', () => {
  it('⭐ios · android면 그 값이 <html>에 붙는다', () => {
    w.__SPRINTABLE_SHELL__ = { platform: 'ios' };
    expect(run()).toBe('ios');
    w.__SPRINTABLE_SHELL__ = { platform: 'android', pushRegister: {} };
    expect(run()).toBe('android');
  });

  it('⭐macos(맥 데스크톱 앱 = 마우스) · 전역 없음(일반 브라우저) · 엉뚱한 값은 안 붙는다', () => {
    w.__SPRINTABLE_SHELL__ = { platform: 'macos' };
    expect(run()).toBeNull();
    delete w.__SPRINTABLE_SHELL__;
    expect(run()).toBeNull();
    for (const bad of [null, 'ios', 7, {}, { platform: 'windows' }, { platform: 'IOS' }, { platform: ['ios'] }]) {
      w.__SPRINTABLE_SHELL__ = bad;
      expect(run(), JSON.stringify(bad)).toBeNull();
    }
  });

  it('⭐전역 접근이 던져도 화면이 안 깨진다(try/catch)', () => {
    Object.defineProperty(window, '__SPRINTABLE_SHELL__', { configurable: true, get() { throw new Error('boom'); } });
    try {
      expect(() => run()).not.toThrow();
      expect(document.documentElement.getAttribute(SHELL_ATTRIBUTE)).toBeNull();
    } finally {
      delete (window as unknown as ShellWindow).__SPRINTABLE_SHELL__;
    }
  });

  it('속성 이름은 앱 쪽이 정한 data-sprintable-shell 그대로 · CSS 변형도 같은 이름을 읽는다', () => {
    expect(SHELL_ATTRIBUTE).toBe('data-sprintable-shell');
    const css = readFileSync(resolve(__dirname, '../styles/design-system.css'), 'utf-8');
    expect(css).toContain(':root[data-sprintable-shell="ios"]');
    expect(css).toContain(':root[data-sprintable-shell="android"]');
    expect(css).not.toContain('[data-sprintable-shell="macos"]');
  });

  it('⭐루트 layout의 <head> 안에 동기 인라인 스크립트로 실린다(<body> 앞 — async · defer · src 없음)', () => {
    const src = readFileSync(resolve(__dirname, '../app/layout.tsx'), 'utf-8');
    const head = src.slice(src.indexOf('<head>'), src.indexOf('</head>'));
    const withoutComments = head.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    const tag = /<script\b[^>]*dangerouslySetInnerHTML=\{\{ __html: SHELL_ATTRIBUTE_SCRIPT \}\}[^>]*\/>/.exec(withoutComments);
    expect(tag, '<head> 안에 SHELL_ATTRIBUTE_SCRIPT 스크립트').not.toBeNull();
    expect(tag![0]).not.toMatch(/\b(async|defer|src)\b/);
    expect(src.indexOf('<head>')).toBeLessThan(src.indexOf('<body'));
  });

  it('⭐CSP script-src가 인라인 스크립트를 허용한다(막히면 속성이 영영 안 달린다)', () => {
    const cfg = readFileSync(resolve(__dirname, '../../next.config.ts'), 'utf-8');
    const line = cfg.split('\n').find((l) => l.includes('"script-src '))!;
    expect(line).toContain("'unsafe-inline'");
  });
});
