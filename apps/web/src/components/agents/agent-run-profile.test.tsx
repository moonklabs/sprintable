// @vitest-environment jsdom
//
// story #4540 (E-DESKTOP-2 C-5) — the «실행» group: pickers offer only what the measured table takes, a runtime change sends
// model · effort back to the defaults, a model change drops an effort the new model doesn't take, many agents start «그대로
// 두기», and the saved line points to the desktop app (no restart button on the web · PO ⓓ).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { effortsFor, keepEffortIfTaken, modelNameOk, saveErrorKey, sharedRuntime, type RunProfileOptions } from '@/lib/agent-run-profile';
import { CUSTOM, DEFAULT, KEEP, draftBody, draftReady, initialDraft, withModel, withRuntime } from './agent-run-profile-fields';
import { AgentRunProfileSection } from './agent-run-profile-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const E5 = ['low', 'medium', 'high', 'xhigh', 'max'];
const OPTIONS: RunProfileOptions = {
  runtimes: [
    { runtime: 'claude-code', models: [{ name: 'opus', efforts: E5 }, { name: 'sonnet', efforts: E5 }], custom_model_efforts: E5 },
    {
      runtime: 'codex',
      models: [{ name: 'gpt-6-sol', efforts: [...E5, 'ultra'] }, { name: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] }],
      custom_model_efforts: ['low', 'medium', 'high', 'xhigh'],
    },
  ],
  model_pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$',
};

describe('the table the pickers follow', () => {
  it('a listed model has its own efforts; a typed-in name or the default gets the shared ones, low → high', () => {
    expect(effortsFor(OPTIONS, 'codex', 'gpt-6-sol')).toContain('ultra');
    expect(effortsFor(OPTIONS, 'codex', 'gpt-5.5')).not.toContain('max');
    expect(effortsFor(OPTIONS, 'codex', 'mine')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(effortsFor(OPTIONS, 'codex', null)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(keepEffortIfTaken(['low'], 'max')).toBeNull();
  });

  it('a typed-in name is one shape — nothing that could be more than a name', () => {
    for (const bad of ['opus 4', '-opus', 'opus[1m]', 'a=b', 'a;b', '"opus"', 'a'.repeat(65)]) expect(modelNameOk(OPTIONS, bad)).toBe(false);
    expect(modelNameOk(OPTIONS, 'gpt-6.1-sol')).toBe(true);
  });

  it('many agents share a runtime only when every one has it', () => {
    expect(sharedRuntime(['codex', 'codex'])).toBe('codex');
    expect(sharedRuntime(['codex', 'claude-code'])).toBeNull();
  });

  it('the server codes become their lines; 403 is about who may change it', () => {
    expect(saveErrorKey(403, undefined)).toBe('runProfileErrorForbidden');
    expect(saveErrorKey(422, 'invalid_effort')).toBe('runProfileErrorEffort');
    expect(saveErrorKey(422, 'mixed_runtime')).toBe('runProfileErrorMixed');
    expect(saveErrorKey(500, undefined)).toBe('runProfileErrorGeneric');
  });
});

describe('the draft', () => {
  it('opens on what the agent has; a name off the list opens as «직접 입력»', () => {
    expect(initialDraft(OPTIONS, { runtime: 'codex', model: 'gpt-6-sol', effort: 'ultra' })).toMatchObject({ modelChoice: 'gpt-6-sol', effort: 'ultra' });
    expect(initialDraft(OPTIONS, { runtime: 'codex', model: 'mine', effort: null })).toMatchObject({ modelChoice: CUSTOM, customModel: 'mine', effort: DEFAULT });
    expect(draftBody(initialDraft(null, null))).toEqual({ runtime: 'keep', model: 'keep', effort: 'keep' });
  });

  it('a runtime change sends model and effort back to the defaults', () => {
    const d = initialDraft(OPTIONS, { runtime: 'codex', model: 'gpt-6-sol', effort: 'ultra' });
    expect(draftBody(withRuntime(d, 'claude-code', false))).toEqual({ runtime: 'claude-code', model: null, effort: null });
  });

  it('a model change drops an effort the new model does not take, and keeps one it does', () => {
    const d = initialDraft(OPTIONS, { runtime: 'codex', model: 'gpt-6-sol', effort: 'ultra' });
    expect(withModel(d, 'gpt-5.5', OPTIONS, 'codex').effort).toBe(DEFAULT);
    const high = { ...d, effort: 'high' };
    expect(withModel(high, 'gpt-5.5', OPTIONS, 'codex').effort).toBe('high');
    expect(withModel({ ...d, effort: KEEP }, 'gpt-5.5', OPTIONS, 'codex').effort).toBe(KEEP);
  });

  it('a typed-in name off the shape cannot be sent', () => {
    const d = { runtime: 'codex', modelChoice: CUSTOM, customModel: 'a b', effort: DEFAULT };
    expect(draftReady(d, OPTIONS)).toBe(false);
    expect(draftReady({ ...d, customModel: 'mine' }, OPTIONS)).toBe(true);
  });
});

describe('AgentRunProfileSection', () => {
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

  function stub(profile: Record<string, unknown>, put?: () => Response) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/options')) return new Response(JSON.stringify({ data: OPTIONS }));
      if (init?.method === 'PUT' && put) return put();
      return new Response(JSON.stringify({ data: profile }));
    }));
    return calls;
  }

  async function render(canChange: boolean, put?: () => Response) {
    const profile = { agent_id: 'a1', runtime: 'codex', model: 'gpt-6-sol', effort: 'ultra', version: 3, updated_at: null, can_change: canChange };
    const calls = stub(profile, put);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <AgentRunProfileSection agentId="a1" runtimeType="codex" />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    return calls;
  }

  it('someone who may not change it reads the values — the effort with its real value beside the word', async () => {
    await render(false);
    const text = container.textContent ?? '';
    expect(text).toContain('실행');
    expect(text).toContain('바꾼 값은 다음에 시작할 때부터 써요');
    expect(text).toContain('gpt-6-sol');
    expect(text).toContain('울트라');
    expect(container.querySelector('code')?.textContent).toBe('ultra');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '저장')).toBe(false);
  });

  it('there is no restart on the web — the only button is save, and it waits for a change', async () => {
    await render(true);
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(buttons.some((b) => b.includes('다시 시작'))).toBe(false);
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === '저장') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});
