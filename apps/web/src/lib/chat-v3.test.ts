import { afterEach, describe, expect, it } from 'vitest';
import { isChatV3Enabled } from './chat-v3';

describe('isChatV3Enabled', () => {
  const original = process.env['CHAT_V3_ENABLED'];
  afterEach(() => {
    if (original === undefined) delete process.env['CHAT_V3_ENABLED'];
    else process.env['CHAT_V3_ENABLED'] = original;
  });

  it('⭐"true"면 활성', () => {
    process.env['CHAT_V3_ENABLED'] = 'true';
    expect(isChatV3Enabled()).toBe(true);
  });

  it('미설정이면 비활성', () => {
    delete process.env['CHAT_V3_ENABLED'];
    expect(isChatV3Enabled()).toBe(false);
  });

  it('다른 값(예: "1")이면 비활성(정확히 "true"만)', () => {
    process.env['CHAT_V3_ENABLED'] = '1';
    expect(isChatV3Enabled()).toBe(false);
  });
});
