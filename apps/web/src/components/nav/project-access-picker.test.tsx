// @vitest-environment jsdom
// [SID:4681] (D3 · piece ②): the «접근 줄 에이전트» check list — the organization's agents from the workforce list, every box OFF to start,
// inactive agents and the reserved publisher left out; a check tells the dialog; an empty list and a failed read each say so.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const { ProjectAccessPicker, grantableAgents } = await import('./project-access-picker');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AGENTS = [
  { id: 'a-1', name: '민 레', is_active: true, runtime_type: 'claude-code' },
  { id: 'a-2', name: '유나 홀름', is_active: true, runtime_type: 'claude-code' },
  { id: 'a-off', name: '쉬는 에이전트', is_active: false, runtime_type: 'claude-code' },
  { id: 'a-sys', name: '시스템 발행', is_active: true, runtime_type: 'system-publisher' },
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); fetchWithAuth.mockReset(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function draw(selected: string[], onChange = vi.fn()) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><ProjectAccessPicker selected={selected} onChange={onChange} idPrefix="t" /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return onChange;
}

describe('[SID:4681] grantableAgents', () => {
  it('keeps active agents, drops inactive ones and the reserved publisher, keeps the order', () => {
    expect(grantableAgents(AGENTS).map((a) => a.id)).toEqual(['a-1', 'a-2']);
    expect(grantableAgents([{ id: 'x', name: 'x' }]).length).toBe(1); // is_active absent = active
  });
});

describe('[SID:4681] ProjectAccessPicker', () => {
  it('reads the workforce list (/api/team-members?type=agent) and draws every grantable agent with its box OFF', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ data: AGENTS }) });
    await draw([]);
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/team-members?type=agent');
    const boxes = [...host.querySelectorAll<HTMLInputElement>('[data-testid="project-access-checkbox"]')];
    expect(boxes.map((b) => b.getAttribute('data-agent-id'))).toEqual(['a-1', 'a-2']);
    expect(boxes.every((b) => !b.checked)).toBe(true);
    // Yuna §G-3 (ux1-copy-1013 · story 4680/4677 — «프로젝트 팀에 넣기» words, replacing §F's «접근» ones in one go) letter for letter
    expect(host.querySelector('legend')?.textContent).toBe('프로젝트 팀에 넣을 에이전트 (선택)');
    expect(host.textContent).toContain('고른 에이전트가 이 프로젝트 팀에 들어가 일해요. 지금 안 골라도 돼요.');
    // each box has a label naming the agent (the label is the accessible name)
    expect(host.querySelector('label[for="t-agent-a-1"]')?.textContent).toBe('민 레');
  });

  it('a check adds the id, an uncheck removes it (the dialog owns the list)', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ data: AGENTS }) });
    const onChange = await draw(['a-2']);
    const [b1, b2] = [...host.querySelectorAll<HTMLInputElement>('[data-testid="project-access-checkbox"]')];
    expect(b2!.checked).toBe(true);
    await act(async () => { b1!.click(); });
    expect(onChange).toHaveBeenLastCalledWith(['a-2', 'a-1']);
    await act(async () => { b2!.click(); });
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('no agents in the organization: one line, no boxes', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await draw([]);
    expect(host.querySelector('[data-testid="project-access-empty"]')?.textContent).toBe('이 조직에 에이전트가 아직 없어요.');
    expect(host.querySelectorAll('[data-testid="project-access-checkbox"]').length).toBe(0);
  });

  it('the list cannot be read: says so with [다시 시도] (the project can still be made · access later in settings › 접근 권한)', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, json: async () => ({}) });
    await draw([]);
    const line = host.querySelector('[data-testid="project-access-load-error"]');
    expect(line?.querySelector('span')?.textContent).toBe('에이전트 목록을 읽지 못했어요 — 팀은 나중에 프로젝트 설정 › 접근 권한에서 넣을 수 있어요.'); // §G-3
    expect(host.querySelectorAll('[data-testid="project-access-checkbox"]').length).toBe(0);
    // Yuna §F (non-blocking): [다시 시도] reads once more — and the list comes
    fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ data: AGENTS }) });
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="project-access-retry"]')!;
    expect(retry.textContent).toBe('다시 시도');
    await act(async () => { retry.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="project-access-load-error"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="project-access-checkbox"]').length).toBe(2);
  });
});
