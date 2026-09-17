// story #4012 AC3 — 스위치 판정 순수 함수 pin. `return desktopDownloadEnabled === 'true'`를
// `return true`(또는 판정 삭제)로 바꾸면 아래 '꺼짐 케이스'가 RED.
import { describe, expect, it } from 'vitest';
import { isDesktopDownloadEnabled } from './desktop-download-gate';

describe('isDesktopDownloadEnabled', () => {
  it('DESKTOP_DOWNLOAD_ENABLED="true" → true(켜짐)', () => {
    expect(isDesktopDownloadEnabled('true')).toBe(true);
  });

  it('DESKTOP_DOWNLOAD_ENABLED="false" → false(꺼짐) — 판정을 지우면 이 케이스가 RED', () => {
    expect(isDesktopDownloadEnabled('false')).toBe(false);
  });

  it('DESKTOP_DOWNLOAD_ENABLED 미설정(undefined) → false(prod-safe 기본값)', () => {
    expect(isDesktopDownloadEnabled(undefined)).toBe(false);
  });

  it('알 수 없는 값(오타·대소문자·빈 문자열) → false(fail-closed, 정확히 "true"일 때만 켠다)', () => {
    expect(isDesktopDownloadEnabled('True')).toBe(false);
    expect(isDesktopDownloadEnabled('TRUE')).toBe(false);
    expect(isDesktopDownloadEnabled('1')).toBe(false);
    expect(isDesktopDownloadEnabled('')).toBe(false);
  });
});
