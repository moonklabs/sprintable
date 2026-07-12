// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyCaptureConditions, canPngExport } from './canvas-export';

describe('canPngExport (html2canvas는 sandbox="" iframe 안을 못 읽는다 — html 포맷만 제외)', () => {
  it('allows png export for tree and image formats (plain DOM, no cross-origin iframe)', () => {
    expect(canPngExport('tree')).toBe(true);
    expect(canPngExport('image')).toBe(true);
  });

  it('disallows png export for html format (sandboxed iframe blocks capture)', () => {
    expect(canPngExport('html')).toBe(false);
  });
});

describe('applyCaptureConditions (캡처 직전 순간 적용 + 복원 — BE엔 없는 순수 클라 조건)', () => {
  it('applies a mobile width and restores the original width on cleanup', () => {
    const el = document.createElement('div');
    el.style.width = '800px';
    const restore = applyCaptureConditions(el, 'mobile', 'light');
    expect(el.style.width).toBe('390px');
    restore();
    expect(el.style.width).toBe('800px');
  });

  it('leaves width untouched for desktop viewport', () => {
    const el = document.createElement('div');
    el.style.width = '800px';
    const restore = applyCaptureConditions(el, 'desktop', 'light');
    expect(el.style.width).toBe('800px');
    restore();
    expect(el.style.width).toBe('800px');
  });

  it('adds the dark class for dark theme and removes it on cleanup when it was absent before', () => {
    const el = document.createElement('div');
    const restore = applyCaptureConditions(el, 'desktop', 'dark');
    expect(el.classList.contains('dark')).toBe(true);
    restore();
    expect(el.classList.contains('dark')).toBe(false);
  });

  it('preserves a pre-existing dark class after a light-theme capture cleanup (does not clobber caller state)', () => {
    const el = document.createElement('div');
    el.classList.add('dark');
    const restore = applyCaptureConditions(el, 'desktop', 'light');
    expect(el.classList.contains('dark')).toBe(false);
    restore();
    expect(el.classList.contains('dark')).toBe(true);
  });
});
