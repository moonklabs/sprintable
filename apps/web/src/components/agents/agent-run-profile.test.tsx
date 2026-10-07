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
import { AgentRunProfileFields, CUSTOM, DEFAULT, KEEP, draftBody, draftReady, initialDraft, withModel, withRuntime } from './agent-run-profile-fields';
import { AgentRunProfileSection } from './agent-run-profile-section';
import { AgentRunProfileBulkDialog } from './agent-run-profile-bulk-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// story #4598 — the section names the org's owners on the «not an owner» line (the /desktop card's reading of the org)
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ orgId: 'org-1' }) }));

const E5 = ['low', 'medium', 'high', 'xhigh', 'max'];
const OPTIONS: RunProfileOptions = {
  runtimes: [
    // story 4540: each runtime's own rule, as the server serves it (backend agent_run_profile.py MODEL_NAMES)
    { runtime: 'claude-code', models: [{ name: 'opus', efforts: E5 }, { name: 'sonnet', efforts: E5 }], custom_model_efforts: E5, model_pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}(\\[1m\\])?$' },
    {
      runtime: 'codex',
      models: [{ name: 'gpt-6-sol', efforts: [...E5, 'ultra'] }, { name: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] }],
      custom_model_efforts: ['low', 'medium', 'high', 'xhigh'],
      model_pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$',
    },
  ],
  model_pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$',
};

function nameOf(el: Element): string {
  return (el.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

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

  it('[SID:4540] Claude takes its 1M id with the «[1m]» tail · Codex never · an unknown runtime (bulk «그대로 두기») the strictest', () => {
    expect(modelNameOk(OPTIONS, 'claude-opus-5-5[1m]', 'claude-code')).toBe(true);
    for (const bad of ['claude-opus-5-5[1M]', 'claude-opus-5-5[1m][1m]', 'x[1m]y', '[1m]', '-x[1m]', `${'a'.repeat(65)}[1m]`]) {
      expect(modelNameOk(OPTIONS, bad, 'claude-code')).toBe(false);
    }
    expect(modelNameOk(OPTIONS, 'gpt-5.6-luna[1m]', 'codex')).toBe(false);
    expect(modelNameOk(OPTIONS, 'claude-opus-5-5[1m]', null)).toBe(false);
    expect(modelNameOk(OPTIONS, 'claude-opus-5-5[1m]', 'keep')).toBe(false);
  });

  it('many agents share a runtime only when every one has it', () => {
    expect(sharedRuntime(['codex', 'codex'])).toBe('codex');
    expect(sharedRuntime(['codex', 'claude-code'])).toBeNull();
  });

  it('the server codes become their lines; 403 is about who may change it', () => {
    expect(saveErrorKey(403, undefined)).toBe('runProfileErrorForbidden');
    expect(saveErrorKey(403, 'owner_required')).toBe('runProfileErrorOwnerRequired'); // story #4598 (Yuna ①): the switch is an owner's
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

  it('[SID:4540 · 유나 4956] Save and the field judge a typed name on the same runtime — a kept runtime is the shared one', () => {
    const kept = { runtime: KEEP, modelChoice: CUSTOM, customModel: 'claude-opus-5-5[1m]', effort: KEEP };
    expect(draftReady(kept, OPTIONS, 'claude-code')).toBe(true);
    expect(draftReady(kept, OPTIONS, 'codex')).toBe(false);
    expect(draftReady(kept, OPTIONS, null)).toBe(false);
  });
});

describe('the refusal under a typed-in name says what that runtime takes (유나 4956)', () => {
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
  });

  async function refusal(runtime: string, customModel: string, sharedRuntime: string | null = null): Promise<string> {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <AgentRunProfileFields options={OPTIONS} draft={{ runtime, modelChoice: CUSTOM, customModel, effort: DEFAULT }} onChange={() => {}} sharedRuntime={sharedRuntime} keepAllowed={runtime === KEEP} />
        </NextIntlClientProvider>,
      );
    });
    const input = container.querySelector('input[aria-invalid="true"]');
    return input ? (input.parentElement?.querySelector('p')?.textContent ?? '') : '';
  }

  it('Claude refused → the line that names the [1m] tail · Codex refused → the plain line · an accepted name → no refusal', async () => {
    const claude = koMessages.agents.runProfileModelCustomShapeClaude;
    const plain = koMessages.agents.runProfileModelCustomShape;
    expect(await refusal('claude-code', 'claude-opus-5-5[1M]')).toBe(claude);
    expect(await refusal(KEEP, 'x[2m]', 'claude-code')).toBe(claude);
    expect(await refusal('codex', 'gpt-5.6-luna[1m]')).toBe(plain);
    expect(await refusal('claude-code', 'claude-opus-5-5[1m]')).toBe('');
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

  it('each picker is named by its field — «런타임 · 모델 · 생각 깊이» before its value (유나 4943 ①)', async () => {
    await render(true);
    const triggers = [...container.querySelectorAll('button[aria-labelledby]')];
    expect(triggers.map(nameOf)).toEqual(['런타임 Codex', '모델 gpt-6-sol', '생각 깊이 울트라']);
  });
});

// story #4598 (contract v0.1 §1 · §4 · Yuna's copy `yuna/4598-unattended-copy.md` ①) — «묻지 않고 일하기»: an owner of a Claude Code
// agent gets the switch + why, saved with [저장] (only that body carries it); anyone else gets no switch but the visible «소유자(…)만»
// line naming the owners; a Codex agent gets the fact line only. Mutation: the switch drawn for a non-owner → RED.
describe('AgentRunProfileSection — «묻지 않고 일하기» (story #4598)', () => {
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

  const unattendedSwitch = () => container.querySelector<HTMLElement>('[data-testid="run-profile-unattended"] [role="switch"]');
  const unattendedLine = () => container.querySelector<HTMLElement>('[data-testid="run-profile-unattended-line"]')?.textContent ?? null;
  const saveButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent === '저장') as HTMLButtonElement | undefined;
  const tick = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };

  async function render(profile: Record<string, unknown>, put?: () => Response) {
    const puts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/options')) return new Response(JSON.stringify({ data: OPTIONS }));
      // the org's remote-control reading — where the owners' names come from (story #4583 shape)
      if (url.endsWith('/remote-control')) return new Response(JSON.stringify({ data: { enabled: true, enabled_at: null, can_change: false, owner_names: ['윤재', '도선'] } }));
      if (init?.method === 'PUT') {
        puts.push(String(init.body));
        if (put) return put();
        return new Response(JSON.stringify({ data: { ...profile, ...JSON.parse(String(init.body)), version: 4 } }));
      }
      return new Response(JSON.stringify({ data: profile }));
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <AgentRunProfileSection agentId="a1" runtimeType="codex" />
        </NextIntlClientProvider>,
      );
    });
    await tick();
    return puts;
  }
  const base = { agent_id: 'a1', runtime: 'claude-code', model: 'opus', effort: 'high', version: 3, updated_at: null, can_change: true };
  const ag = koMessages.agents as Record<string, string>;

  it('an owner of a Claude Code agent: the switch (named «묻지 않고 일하기») + the why · flipping it wakes [저장] · the body carries unattended · reads back', async () => {
    const puts = await render({ ...base, unattended: false, can_change_unattended: true });
    expect(ag.runProfileUnattended).toBe('묻지 않고 일하기');
    expect(container.textContent).toContain(ag.runProfileUnattendedHelp);
    expect(unattendedLine()).toBeNull();
    const sw = unattendedSwitch()!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(nameOf(sw)).toBe(ag.runProfileUnattended);
    expect(saveButton()!.disabled).toBe(true);
    await act(async () => { sw.click(); });
    expect(unattendedSwitch()!.getAttribute('aria-checked')).toBe('true');
    expect(saveButton()!.disabled).toBe(false);
    await act(async () => { saveButton()!.click(); });
    await tick();
    expect(JSON.parse(puts[0])).toEqual({ runtime: 'claude-code', model: 'opus', effort: 'high', unattended: true });
    expect(unattendedSwitch()!.getAttribute('aria-checked')).toBe('true');
    expect(saveButton()!.disabled).toBe(true);
  });

  it('an admin (may change model · effort, not the switch): no switch — the visible «소유자(윤재 · 도선)만» line with the value · a save carries no unattended', async () => {
    const puts = await render({ ...base, unattended: true, can_change_unattended: false });
    expect(unattendedSwitch()).toBeNull();
    expect(unattendedLine()).toBe('묻지 않고 일하기 · 켜짐 — 조직 소유자(윤재 · 도선)만 켜고 끌 수 있어요');
    // a model change by the admin: the body never carries the switch (absent = as it is on the server)
    const trigger = [...container.querySelectorAll('button[aria-labelledby]')].find((b) => nameOf(b).startsWith('모델')) as HTMLElement;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === 'sonnet') as HTMLElement;
    await act(async () => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { saveButton()!.click(); });
    await tick();
    expect(JSON.parse(puts[0])).toEqual({ runtime: 'claude-code', model: 'sonnet', effort: 'high' });
  });

  it('a reader (may change nothing) · an older server (no field): no switch · the «꺼짐 — 소유자만» line · no [저장]', async () => {
    await render({ ...base, can_change: false });
    expect(unattendedSwitch()).toBeNull();
    expect(unattendedLine()).toBe('묻지 않고 일하기 · 꺼짐 — 조직 소유자(윤재 · 도선)만 켜고 끌 수 있어요');
    expect(saveButton()).toBeUndefined();
  });

  it('a Codex agent: the fact line only — no switch even for an owner · the body carries no unattended (PO 11:37Z · Yuna ①-Codex)', async () => {
    const puts = await render({ ...base, runtime: 'codex', model: 'gpt-6-sol', effort: 'ultra', unattended: false, can_change_unattended: true });
    expect(unattendedSwitch()).toBeNull();
    expect(unattendedLine()).toBe(ag.runProfileUnattendedCodex);
    expect(unattendedLine()).not.toContain('소유자');
    const trigger = [...container.querySelectorAll('button[aria-labelledby]')].find((b) => nameOf(b).startsWith('모델')) as HTMLElement;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === 'gpt-5.5') as HTMLElement;
    await act(async () => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { saveButton()!.click(); });
    await tick();
    expect(JSON.parse(puts[0])).toEqual({ runtime: 'codex', model: 'gpt-5.5', effort: null });
  });

  it('403 owner_required → the all-or-nothing line in a person\'s words', async () => {
    await render({ ...base, unattended: false, can_change_unattended: true },
      () => new Response(JSON.stringify({ data: null, error: { code: 'owner_required' } }), { status: 403 }));
    await act(async () => { unattendedSwitch()!.click(); });
    await act(async () => { saveButton()!.click(); });
    await tick();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(ag.runProfileErrorOwnerRequired);
  });
});

describe('AgentRunProfileBulkDialog', () => {
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

  it('opens «그대로 두기» everywhere, says why model · effort wait with mixed runtimes, and after saving focus is on [닫기] (유나 4943 ②)', async () => {
    const puts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/options')) return new Response(JSON.stringify({ data: OPTIONS }));
      puts.push(String(init?.body));
      return new Response(JSON.stringify({ data: { profiles: [] } }));
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <AgentRunProfileBulkDialog
            agents={[{ id: 'a', runtime_type: 'codex' }, { id: 'b', runtime_type: 'claude-code' }]}
            open
            onOpenChange={() => {}}
            onSaved={() => {}}
          />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    const named = [...document.querySelectorAll('button[aria-labelledby]')];
    expect(named.map(nameOf)).toEqual(['런타임 그대로 두기']);
    expect(document.body.textContent).toContain('고른 에이전트의 런타임이 서로 달라요');

    const trigger = named[0] as HTMLElement;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === 'Claude Code') as HTMLElement;
    await act(async () => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const apply = [...document.querySelectorAll('button')].find((b) => b.textContent === '에이전트 2개에 적용') as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    await act(async () => { apply.click(); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(JSON.parse(puts[0])).toEqual({ agent_ids: ['a', 'b'], runtime: 'claude-code', model: null, effort: null });
    expect(document.activeElement?.textContent).toBe('닫기');
    expect(document.body.textContent).toContain('지금 바꾸려면 데스크톱 앱에서 차례로 다시 시작해 주세요');
  });
});
