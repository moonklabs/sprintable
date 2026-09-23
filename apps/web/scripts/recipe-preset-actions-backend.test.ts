// story #4224 — 커밋된 백엔드 파생물(backend/app/i18n/recipe_preset_actions.json)이 FE 원천(실제 import한 PLATFORM_PRESET_ACTION_KEY +
// messages)에서 만든 것과 한 글자라도 다르면 RED. FE 문안이나 표를 바꾸면 재생성 명령 하나로 맞춘다.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLATFORM_PRESET_ACTION_KEY } from '../src/lib/platform-preset-copy';
import {
  BACKEND_PRESET_ACTIONS_PATH,
  REGENERATE_COMMAND,
  buildBackendPresetActionTable,
  renderBackendPresetActionTable,
} from './recipe-preset-actions-backend';

describe('백엔드용 플랫폼 프리셋 action 파생물(story #4224)', () => {
  it('⭐커밋된 JSON = FE 원천에서 만든 값(다르면 재생성)', () => {
    const committed = readFileSync(BACKEND_PRESET_ACTIONS_PATH, 'utf8');
    const expected = renderBackendPresetActionTable(buildBackendPresetActionTable());
    expect(committed === expected, `backend/app/i18n/recipe_preset_actions.json이 FE 원천과 다름 — \`${REGENERATE_COMMAND}\` 로 다시 생성해 커밋할 것`).toBe(true);
  });

  it('표의 모든 항목이 파생물에 있고 ko·en 모두 비지 않음 · en엔 한글 0', () => {
    const table = buildBackendPresetActionTable();
    expect(Object.keys(table).sort()).toEqual(Object.keys(PLATFORM_PRESET_ACTION_KEY).sort());
    for (const [k, v] of Object.entries(table)) {
      expect(v.ko, k).toBeTruthy();
      expect(v.en, k).toBeTruthy();
      expect(/[가-힣]/.test(v.en), k).toBe(false);
    }
  });
});
