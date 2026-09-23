// story #4224 — 백엔드용 플랫폼 프리셋 action 파생물 재생성(원천: FE PLATFORM_PRESET_ACTION_KEY + messages recipePreset).
import { writeFileSync } from 'node:fs';
import { BACKEND_PRESET_ACTIONS_PATH, buildBackendPresetActionTable, renderBackendPresetActionTable } from './recipe-preset-actions-backend';

const table = buildBackendPresetActionTable();
writeFileSync(BACKEND_PRESET_ACTIONS_PATH, renderBackendPresetActionTable(table));
console.log(`wrote ${BACKEND_PRESET_ACTIONS_PATH} (${Object.keys(table).length} entries)`);
