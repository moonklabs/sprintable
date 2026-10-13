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
    expect(host.textContent).toContain('접근 줄 에이전트');
    expect(host.textContent).toContain('체크한 에이전트가 이 프로젝트에서 일할 수 있어요. 지금 안 골라도 돼요.');
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

  it('the list cannot be read: says so (the project can still be made · access later in settings)', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, json: async () => ({}) });
    await draw([]);
    expect(host.querySelector('[data-testid="project-access-load-error"]')?.textContent).toBe('에이전트 목록을 읽지 못했어요 — 접근은 나중에 프로젝트 설정에서 줄 수 있어요.');
    expect(host.querySelectorAll('[data-testid="project-access-checkbox"]').length).toBe(0);
  });
});
