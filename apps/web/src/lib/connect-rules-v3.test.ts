import { afterEach, describe, expect, it } from 'vitest';
import { isConnectRulesV3Enabled } from './connect-rules-v3';

describe('isConnectRulesV3Enabled', () => {
  const original = process.env.CONNECT_RULES_V3_ENABLED;

  afterEach(() => {
    process.env.CONNECT_RULES_V3_ENABLED = original;
  });

  it('⭐"true"면 활성', () => {
    process.env.CONNECT_RULES_V3_ENABLED = 'true';
    expect(isConnectRulesV3Enabled()).toBe(true);
  });

  it('미설정이면 비활성(기본값 off)', () => {
    delete process.env.CONNECT_RULES_V3_ENABLED;
    expect(isConnectRulesV3Enabled()).toBe(false);
  });

  it('"true" 외 값(예: "1"·"TRUE")은 비활성 — 정확 일치만', () => {
    process.env.CONNECT_RULES_V3_ENABLED = '1';
    expect(isConnectRulesV3Enabled()).toBe(false);
    process.env.CONNECT_RULES_V3_ENABLED = 'TRUE';
    expect(isConnectRulesV3Enabled()).toBe(false);
  });
});
