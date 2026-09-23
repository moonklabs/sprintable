// story #4202 — 플랫폼 마케팅 프리셋 이름·설명 로케일 헬퍼.
import { describe, expect, it } from 'vitest';
import enMessages from '../../messages/en.json';
import { presetDescription, presetName } from './platform-preset-copy';

const t = (key: string) => (enMessages.recipePreset as Record<string, string>)[key] ?? `MISSING:${key}`;
const PLATFORM = { key: 'preset.marketing.video_production', org_id: null, name: '영상 제작(릴스·쇼츠)', description: '원문 설명' };

describe('presetName / presetDescription', () => {
  it('플랫폼 프리셋 → messages 문안', () => {
    expect(presetName(PLATFORM, t)).toBe(enMessages.recipePreset.videoProductionName);
    expect(presetDescription(PLATFORM, t)).toBe(enMessages.recipePreset.videoProductionDescription);
  });
  it('조직 커스텀 정의(org_id 있음) → 원문', () => {
    const org = { ...PLATFORM, org_id: 'org-1' };
    expect(presetName(org, t)).toBe('영상 제작(릴스·쇼츠)');
    expect(presetDescription(org, t)).toBe('원문 설명');
  });
  it('org_id를 모르는 응답(구 타입) → 원문(조직 정의를 번역문으로 덮지 않는 쪽)', () => {
    const { org_id: _omit, ...legacy } = PLATFORM;
    expect(presetName(legacy, t)).toBe('영상 제작(릴스·쇼츠)');
  });
  it('표에 없는 플랫폼 key → 원문, name이 비면 key', () => {
    expect(presetName({ key: 'preset.marketing.new', org_id: null, name: '', description: null }, t)).toBe('preset.marketing.new');
    expect(presetDescription({ key: 'preset.marketing.new', org_id: null, description: null }, t)).toBe('');
  });
});
