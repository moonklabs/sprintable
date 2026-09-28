// @vitest-environment jsdom
//
// story #4173(PR #4547 까디르 QA 처방 2) — 불변식 «role이 있는 모든 stage가 정확히 한 자리에»가
// 깨지면(앞으로의 정의 모양에서 판별이 어떤 stage를 놓치면) 표시 없이 빠진 채 제출되지 않고,
// 제출을 막고 그 단계를 보여준다(fail-closed). 지금 판별 함수로는 이 상태를 만들 수 없어서
// recipeRoleSlots만 «한 stage를 빠뜨리는» 버전으로 바꿔 끼운다.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { recipeStageLabel } from '@/lib/recipe-stage-label';

vi.mock('@/lib/recipe-role-slots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/recipe-role-slots')>();
  return {
    ...actual,
    recipeRoleSlots: (...args: Parameters<typeof actual.recipeRoleSlots>) =>
      actual.recipeRoleSlots(...args).map((s) => ({ ...s, stages: s.stages.filter((x) => x !== 'animatic') })),
  };
});

import { MarketingRecipeApplyDialog } from './marketing-recipe-apply-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

it('덮이지 않은 단계가 있으면 그 단계를 보여주고, 모든 자리를 골라도 제출이 막힌다', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/team-members')) return { ok: true, json: async () => [{ id: 'agent-1', name: '댄', type: 'agent' }] };
    throw new Error(`unexpected fetch ${url}`);
  }));
  const onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 1 }));
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <MarketingRecipeApplyDialog
          recipe={{
            id: 'r-1', key: 'org.acme.cycle', org_id: 'org-1', name: '레시피', description: null, enabled: true,
            payload_schema: { properties: { stage: { enum: ['draft', 'animatic'] } } },
            stage_metadata: { draft: { role: 'Creator' }, animatic: { role: 'Creator' } },
          }}
          open onOpenChange={() => {}} projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={onSubmit}
        />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
  await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const memberSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
  await act(async () => { memberSelect.value = 'agent-1'; memberSelect.dispatchEvent(new Event('change', { bubbles: true })); });

  const alert = document.body.querySelector('[data-testid="marketing-apply-uncovered-stages"]');
  expect(alert?.getAttribute('role')).toBe('alert');
  expect(alert?.textContent).toContain(recipeStageLabel('animatic', (k) => (koMessages.organization as Record<string, string>)[k]!));
  const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
  expect(submitBtn.hasAttribute('disabled')).toBe(true);
  await act(async () => { submitBtn.click(); });
  expect(onSubmit).not.toHaveBeenCalled();
});
