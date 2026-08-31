import { afterEach, describe, expect, it } from 'vitest';
import { isSupportWidgetEnabled } from './support-widget-flag';

const ENV_KEY = 'NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED';
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

describe('isSupportWidgetEnabled — story #3260 (ee.ts isEEEnabled와 동일 컨벤션)', () => {
  it('정확히 "true"일 때만 활성', () => {
    process.env[ENV_KEY] = 'true';
    expect(isSupportWidgetEnabled()).toBe(true);
  });

  it('미설정(undefined)이면 dev-safe fallback으로 false', () => {
    delete process.env[ENV_KEY];
    expect(isSupportWidgetEnabled()).toBe(false);
  });

  it('"false"·다른 값은 false(문자열 정확 매치만 true)', () => {
    process.env[ENV_KEY] = 'false';
    expect(isSupportWidgetEnabled()).toBe(false);
    process.env[ENV_KEY] = '1';
    expect(isSupportWidgetEnabled()).toBe(false);
  });
});
