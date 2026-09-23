// story #4202 — 플랫폼 마케팅 프리셋(event_definitions.org_id IS NULL · `preset.marketing.*`)의 이름·설명을 로케일별로.
// 워크플로우 프리셋(`preset.workflow.*`)은 story #4203에서 같은 표에 얹는다. 시드는 한국어뿐이라
// 원문을 그대로 그리면 en 화면에도 한국어가 나온다. 플랫폼 프리셋은 key로 messages `recipePreset` 키를 찾고,
// 표에 없는 key·조직 커스텀 정의(org_id 있음)는 원문 그대로. ko 값 = 시드 원문(BE 가드
// tests/test_4202_platform_preset_copy_keys_realdb.py가 key 전수·ko 동일성을 잰다 — 새 프리셋 시드가 이 표 없이 들어오면 RED).
// 타입을 Record<string, string>으로 둔다 — verify-no-unused-i18n-keys 가드는 이 모양의 리터럴 테이블 값만 «읽힌 키»로 본다.
export const PLATFORM_PRESET_NAME_KEY: Record<string, string> = {
  'preset.marketing.social_card_news': 'socialCardNewsName',
  'preset.marketing.social_text_post': 'socialTextPostName',
  'preset.marketing.video_production': 'videoProductionName',
};

export const PLATFORM_PRESET_DESCRIPTION_KEY: Record<string, string> = {
  'preset.marketing.social_card_news': 'socialCardNewsDescription',
  'preset.marketing.social_text_post': 'socialTextPostDescription',
  'preset.marketing.video_production': 'videoProductionDescription',
};

type PresetLike = { key: string; name?: string | null; description?: string | null; org_id?: string | null };
type Translate = (key: string) => string;

function platformKey(table: Record<string, string>, def: PresetLike): string | undefined {
  // org_id가 없는 응답(구 타입)은 플랫폼으로 치지 않는다 — 조직 정의를 번역문으로 덮지 않는 쪽으로 기운다.
  return def.org_id === null ? table[def.key] : undefined;
}

/** 화면 이름. 번역 키가 없으면 원문 name, 그것도 비면 key(기존 `name || key`와 같다). */
export function presetName(def: PresetLike, t: Translate): string {
  const k = platformKey(PLATFORM_PRESET_NAME_KEY, def);
  return k ? t(k) : def.name || def.key;
}

/** 화면 설명. 번역 키가 없으면 원문 description(없으면 빈 문자열). */
export function presetDescription(def: PresetLike, t: Translate): string {
  const k = platformKey(PLATFORM_PRESET_DESCRIPTION_KEY, def);
  return k ? t(k) : def.description ?? '';
}
