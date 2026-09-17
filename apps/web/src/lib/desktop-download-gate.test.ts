// story #4012 AC3 — 스위치 판정 순수 함수 pin. `return deployEnv === 'dev'`를
// `return true`(또는 판정 삭제)로 바꾸면 아래 '꺼짐 케이스'가 RED.
import { describe, expect, it } from 'vitest';
import { isDesktopDownloadEnabled } from './desktop-download-gate';

describe('isDesktopDownloadEnabled', () => {
  it('DEPLOY_ENV=dev → true(켜짐)', () => {
    expect(isDesktopDownloadEnabled('dev')).toBe(true);
  });

  it('DEPLOY_ENV=prod → false(꺼짐) — 판정을 지우면 이 케이스가 RED', () => {
    expect(isDesktopDownloadEnabled('prod')).toBe(false);
  });

  it('DEPLOY_ENV 미설정(undefined) → false(prod-safe 기본값)', () => {
    expect(isDesktopDownloadEnabled(undefined)).toBe(false);
  });

  it('알 수 없는 값(오타·다른 환경명) → false(fail-closed, dev만 예외적으로 켠다)', () => {
    expect(isDesktopDownloadEnabled('staging')).toBe(false);
    expect(isDesktopDownloadEnabled('Dev')).toBe(false);
    expect(isDesktopDownloadEnabled('')).toBe(false);
  });
});
