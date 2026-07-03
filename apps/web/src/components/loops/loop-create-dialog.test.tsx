import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import enMessagesRaw from '../../../messages/en.json';
import koMessagesRaw from '../../../messages/ko.json';
import { localizeRecipe, type WorkflowRecipe } from './loop-create-dialog';

// production `tr` (useTranslations()) resolves against the permissive default `IntlMessages`
// generic (no global next-intl message-type augmentation in this repo) — cast here so the test
// translator has the same loose type instead of the JSON import's inferred literal-key type.
type LooseMessages = { [key: string]: string | LooseMessages };
const enMessages = enMessagesRaw as unknown as LooseMessages;
const koMessages = koMessagesRaw as unknown as LooseMessages;

const BUILTIN_RECIPE: WorkflowRecipe = {
  id: 'loop-agency',
  slug: 'loop-agency',
  name: '루프 에이전시',
  description: '목표·가설 설정 → 브리프 → 실행안 생성 → 인간 선택 → 실행 → 성과 학습까지 이어지는 복리 조직기억 워크플로우. 반복되는 실험(카피·캠페인 variant 등)에 적합.',
  steps: [
    { role: 'Human', label: '목표·가설 정의', pattern: 'goal_hypothesis', action: 'define' },
    { role: 'PO', label: '브리프 작성', pattern: 'brief_doc_approval', action: 'brief' },
  ],
  builtin: true,
};

const CUSTOM_RECIPE: WorkflowRecipe = {
  id: 'a1b2c3',
  slug: 'org-authored-flow',
  name: '조직 자체 워크플로우',
  description: '조직이 직접 작성한 커스텀 레시피 설명',
  steps: [{ role: 'Custom', label: '커스텀 단계', pattern: 'unknown_pattern', action: 'do it' }],
  builtin: false,
};

describe('localizeRecipe (E-LOOP-LEDGER S18-fu)', () => {
  it('translates builtin recipe name/description/step labels for en locale', () => {
    const tr = createTranslator({ locale: 'en', messages: enMessages, namespace: 'workflowRecipes' });
    const localized = localizeRecipe(BUILTIN_RECIPE, tr);
    expect(localized.name).toBe('Loop Agency');
    expect(localized.description).toContain('Compounding org-memory workflow');
    expect(localized.steps[0].label).toBe('Define goal & hypothesis');
    expect(localized.steps[1].label).toBe('Write brief');
  });

  it('resolves builtin recipe through the ko table too (identity mapping, no visual change)', () => {
    const tr = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'workflowRecipes' });
    const localized = localizeRecipe(BUILTIN_RECIPE, tr);
    expect(localized.name).toBe(BUILTIN_RECIPE.name);
    expect(localized.description).toBe(BUILTIN_RECIPE.description);
    expect(localized.steps[0].label).toBe(BUILTIN_RECIPE.steps[0].label);
  });

  it('falls back to BE-original text for a non-builtin (custom/DB) recipe — no crash, no key miss', () => {
    const tr = createTranslator({ locale: 'en', messages: enMessages, namespace: 'workflowRecipes' });
    const localized = localizeRecipe(CUSTOM_RECIPE, tr);
    expect(localized.name).toBe(CUSTOM_RECIPE.name);
    expect(localized.description).toBe(CUSTOM_RECIPE.description);
    expect(localized.steps[0].label).toBe(CUSTOM_RECIPE.steps[0].label);
  });

  it('covers all 4 builtin slugs with complete en translations', () => {
    const recipes = enMessagesRaw.workflowRecipes as Record<string, { name: string; description: string }>;
    for (const slug of ['scrum-3step', 'kanban-simple', 'solo', 'loop-agency']) {
      expect(recipes[slug]?.name).toBeTruthy();
      expect(recipes[slug]?.description).toBeTruthy();
    }
  });
});
