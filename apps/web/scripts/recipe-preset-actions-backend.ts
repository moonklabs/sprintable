/**
 * story #4224(PO 판단 2026-09-23 23:05Z) — 플랫폼 프리셋 stage action 문안의 **백엔드용 파생물**(`backend/app/i18n/recipe_preset_actions.json`).
 * 원천은 FE다(`PLATFORM_PRESET_ACTION_KEY` + messages `recipePreset`). 백엔드 이미지는 `./backend` 컨텍스트로 빌드돼 FE 파일을 못 읽으므로
 * 이 모듈이 실제 표·문안을 import해 만든 JSON을 커밋하고, 백엔드는 JSON만 읽는다. TS를 문자열로 파싱하지 않는다(파싱 가드는 유효한 TS
 * 모양을 놓치고도 초록일 수 있었다 — 미르코 4587 재현). 드리프트는 같은 폴더의 vitest가 잡는다.
 */
import path from 'node:path';
import { PLATFORM_PRESET_ACTION_KEY } from '../src/lib/platform-preset-copy';
import enMessages from '../messages/en.json';
import koMessages from '../messages/ko.json';

export const BACKEND_PRESET_ACTIONS_PATH = path.resolve(__dirname, '../../../backend/app/i18n/recipe_preset_actions.json');
export const REGENERATE_COMMAND = 'pnpm --filter web gen:recipe-preset-actions';

type Catalog = Record<string, string>;

export function buildBackendPresetActionTable(): Record<string, { ko: string; en: string }> {
  const ko = (koMessages as unknown as { recipePreset: Catalog }).recipePreset;
  const en = (enMessages as unknown as { recipePreset: Catalog }).recipePreset;
  const out: Record<string, { ko: string; en: string }> = {};
  for (const stageKey of Object.keys(PLATFORM_PRESET_ACTION_KEY).sort()) {
    const messageKey = PLATFORM_PRESET_ACTION_KEY[stageKey]!;
    const koText = ko[messageKey];
    const enText = en[messageKey];
    if (!koText || !enText) throw new Error(`recipePreset.${messageKey} 문안이 ko/en 중 비어 있음(${stageKey})`);
    out[stageKey] = { ko: koText, en: enText };
  }
  return out;
}

export function renderBackendPresetActionTable(table: Record<string, { ko: string; en: string }>): string {
  return `${JSON.stringify(table, null, 2)}\n`;
}
