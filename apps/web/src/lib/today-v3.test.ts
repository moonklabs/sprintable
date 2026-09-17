import { afterEach, describe, expect, it } from 'vitest';
import { isTodayV3Enabled } from './today-v3';

// story #3962(E-UX-OVERHAUL·「오늘」 구현 3/N) — internal-dogfood.ts와 동형 순수 env
// 플래그(그라운딩 결론, 페드루 PO 確認 2026-09-16 15:36Z).
describe('isTodayV3Enabled', () => {
  const original = process.env.TODAY_V3_ENABLED;

  afterEach(() => {
    process.env.TODAY_V3_ENABLED = original;
  });

  it('⭐"true"면 활성', () => {
    process.env.TODAY_V3_ENABLED = 'true';
    expect(isTodayV3Enabled()).toBe(true);
  });

  it('미설정이면 비활성(기본값 off)', () => {
    delete process.env.TODAY_V3_ENABLED;
    expect(isTodayV3Enabled()).toBe(false);
  });

  it('"true" 외 값(예: "1"·"TRUE")은 비활성 — 정확 일치만', () => {
    process.env.TODAY_V3_ENABLED = '1';
    expect(isTodayV3Enabled()).toBe(false);
    process.env.TODAY_V3_ENABLED = 'TRUE';
    expect(isTodayV3Enabled()).toBe(false);
  });
});
