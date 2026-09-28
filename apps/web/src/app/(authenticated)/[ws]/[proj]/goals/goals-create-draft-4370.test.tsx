// @vitest-environment jsdom
/**
 * story #4370(유나 판정 (가)) — 목표 만들기 창: 여러 줄 칸(설명)이 든 폼이라 **폼 전체**(제목 · 설명 · …)가 프로젝트별 초안 하나.
 * 창이 Esc로 닫혀도 다시 열면 그대로 · 보이는 «취소»와 만들기 성공에서만 지움. 예전엔 창과 함께 폼 상태가 사라졌다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('./goals-context', () => ({ useGoalsRoute: () => ({ wsSlug: 'ws-1', projSlug: 'proj-1' }) }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => <div>{title}{actions}</div>,
}));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentMemberType: 'human' }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = koMessages.goals as Record<string, string>;
let container: HTMLDivElement;
let root: Root;
let createOk = true;

beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  createOk = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/goals?')) return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/goals' && init?.method === 'POST') {
      return createOk
        ? { ok: true, json: async () => ({ data: { id: 'goal-new', title: 'x', status: 'planning', priority: 'medium', stories: [] } }) }
        : { ok: false, json: async () => null };
    }
    return { ok: false, json: async () => null };
  }));
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 50)); }); };
const esc = (t: EventTarget) => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const titleInput = () => document.body.querySelector<HTMLInputElement>(`input[placeholder="${g.fieldTitlePlaceholder}"]`);
const descField = () => document.body.querySelector<HTMLTextAreaElement>(`textarea[placeholder="${g.fieldDescriptionPlaceholder}"]`);
const button = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label);

async function mount() {
  const { GoalsClient } = await import('./goals-client');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><GoalsClient projectId="proj-1" /></NextIntlClientProvider>);
  });
  await settle();
}
async function openCreate() { await act(async () => { button(g.newGoal)!.click(); }); await settle(); }
async function setValue(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function closeByEsc() {
  await act(async () => { descField()!.focus(); });
  await act(async () => { esc(descField()!); });
  await act(async () => { esc(document.activeElement ?? document.body); });
  await settle();
}

describe('목표 만들기 창 폼 초안(story #4370)', () => {
  it('Esc로 닫고 다시 열면 제목 · 설명(폼 전체)이 남아 있다', async () => {
    await mount();
    await openCreate();
    await setValue(titleInput()!, '분기 목표');
    await setValue(descField()!, '여러 줄\n설명');
    await closeByEsc();
    expect(descField()).toBeNull();
    await openCreate();
    expect(titleInput()!.value).toBe('분기 목표');
    expect(descField()!.value).toBe('여러 줄\n설명');
  });

  it('보이는 «취소»는 폼 초안을 지운다', async () => {
    await mount();
    await openCreate();
    await setValue(titleInput()!, '버릴 목표');
    await setValue(descField()!, '버릴 설명');
    await act(async () => { button(g.cancel)!.click(); });
    await settle();
    await openCreate();
    expect(titleInput()!.value).toBe('');
    expect(descField()!.value).toBe('');
  });

  it('만들기 실패는 남기고 · 성공은 지운다', async () => {
    await mount();
    await openCreate();
    await setValue(titleInput()!, '만들 목표');
    await setValue(descField()!, '만들 설명');
    createOk = false;
    await act(async () => { button(g.createGoal)!.click(); });
    await settle();
    expect(descField()!.value).toBe('만들 설명');
    createOk = true;
    await act(async () => { button(g.createGoal)!.click(); });
    await settle();
    await openCreate();
    expect(titleInput()!.value).toBe('');
    expect(descField()!.value).toBe('');
  });
});
