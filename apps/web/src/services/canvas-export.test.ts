// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyCaptureConditions, canPngExport, neutralizeCaptureTransform } from './canvas-export';

describe('canPngExport (html2canvas는 sandbox="" iframe 안을 못 읽는다 — html 포맷만 제외)', () => {
  it('allows png export for tree and image formats (plain DOM, no cross-origin iframe)', () => {
    expect(canPngExport('tree')).toBe(true);
    expect(canPngExport('image')).toBe(true);
  });

  it('disallows png export for html format (sandboxed iframe blocks capture)', () => {
    expect(canPngExport('html')).toBe(false);
  });
});

describe('applyCaptureConditions (캡처 직전 테마 순간 적용 + 복원 — BE엔 없는 순수 클라 조건)', () => {
  it('adds the dark class for dark theme and removes it on cleanup when it was absent before', () => {
    const el = document.createElement('div');
    const restore = applyCaptureConditions(el, 'dark');
    expect(el.classList.contains('dark')).toBe(true);
    restore();
    expect(el.classList.contains('dark')).toBe(false);
  });

  it('preserves a pre-existing dark class after a light-theme capture cleanup (does not clobber caller state)', () => {
    const el = document.createElement('div');
    el.classList.add('dark');
    const restore = applyCaptureConditions(el, 'light');
    expect(el.classList.contains('dark')).toBe(false);
    restore();
    expect(el.classList.contains('dark')).toBe(true);
  });
});

describe('neutralizeCaptureTransform (story d72db00a AC1~2 — 아트보드 전체 프레임·100% 스케일·뷰포트 pan/zoom 무관)', () => {
  it('resets an arbitrary pan/zoom transform to identity for the capture', () => {
    const el = document.createElement('div');
    el.style.transform = 'translate(-320px, 145px) scale(0.36)'; // 임의의 fit 상태 예시
    const restore = neutralizeCaptureTransform(el);
    expect(el.style.transform).toBe('translate(0px, 0px) scale(1)');
    restore();
  });

  it('restores the exact original transform on cleanup regardless of what it was', () => {
    const el = document.createElement('div');
    el.style.transform = 'translate(87px, -12px) scale(2.5)';
    const restore = neutralizeCaptureTransform(el);
    restore();
    expect(el.style.transform).toBe('translate(87px, -12px) scale(2.5)');
  });
});
