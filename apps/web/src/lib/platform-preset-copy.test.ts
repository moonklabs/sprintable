// story #4202 — 플랫폼 마케팅 프리셋 이름·설명 로케일 헬퍼.
import { describe, expect, it } from 'vitest';
import enMessages from '../../messages/en.json';
import koMessages from '../../messages/ko.json';
import { isLocalizedPlatformPreset, PLATFORM_SYSTEM_EVENT_NAME_KEY, presetDescription, presetName } from './platform-preset-copy';

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

describe('시스템(신호형) 이벤트 정의 8종 이름(story #4233 · #4258 · 유나 확정)', () => {
  const ko = (key: string) => (koMessages.recipePreset as Record<string, string>)[key] ?? `MISSING:${key}`;
  const SYSTEM: Array<[string, string, string, string]> = [
    ['preset.gate.verdict', '게이트 판정', 'Gate verdict', '게이트 판정'],
    ['preset.work.assigned', '작업 배정', 'Work assigned', '작업 배정'],
    ['preset.work.status_changed', '작업 상태 변경', 'Work status changed', '작업 상태 변경'],
    ['preset.goal.measured', '목표 측정', 'Goal measured', '목표 측정'],
    ['preset.loop.measure_due', '측정 기한 도과', 'Past measure date', '측정 기한 지남'],
    ['preset.steer.instruct', '방향 전환', 'Direction change', '방향 전환'],
    ['preset.agent_run.cancel_requested', '에이전트 실행 중단 요청', 'Agent run stop request', '에이전트 실행 중단 요청'],
    // story #4258 — 레시피 비동기 발행 멈춤 통지.
    ['preset.recipe.publish_failed', '레시피 발행 멈춤', 'Recipe publishing stopped', '레시피 발행 멈춤'],
  ];

  it('⭐en은 영어 · ko는 유나 문안(«측정 기한 도과» → «측정 기한 지남») · 시드 원문과 무관', () => {
    for (const [key, seedName, en, koName] of SYSTEM) {
      const def = { key, org_id: null, name: seedName, description: null };
      expect(presetName(def, t), key).toBe(en);
      expect(presetName(def, ko), key).toBe(koName);
    }
  });

  // 사이클형 표(PLATFORM_PRESET_NAME_KEY)에 섞지 않는 이유를 잠근다 — 그 표는 채팅 카드 block_template 로케일화의 판정
  // (isLocalizedPlatformPreset)에도 쓰여, 섞이면 시스템 이벤트 카드가 사이클형 카드 규칙(«{name} workflow» 머리말 등)을 탈 수 있다.
  it.each(SYSTEM.map(([key]) => key))('%s는 사이클형 카드 로케일화 대상이 아니다(isLocalizedPlatformPreset === false)', (key) => {
    expect(isLocalizedPlatformPreset({ key, org_id: null, name: '', description: null })).toBe(false);
  });

  it('시스템 이벤트 이름 표 = 위 8종(표와 테스트 목록이 어긋나면 RED)', () => {
    expect(Object.keys(PLATFORM_SYSTEM_EVENT_NAME_KEY).sort()).toEqual(SYSTEM.map(([key]) => key).sort());
  });

  it('같은 key라도 조직 커스텀(org_id 있음)은 원문', () => {
    expect(presetName({ key: 'preset.gate.verdict', org_id: 'org-1', name: '우리 판정', description: null }, t)).toBe('우리 판정');
  });

  it('채팅 이벤트 카드 머리말 en이 목록 이름과 같은 낱말(Work assigned · Work status changed)', () => {
    expect(enMessages.eventCard.workAssignedHeader).toBe('Work assigned');
    expect(enMessages.eventCard.statusChangedHeader).toBe('Work status changed');
  });
});
