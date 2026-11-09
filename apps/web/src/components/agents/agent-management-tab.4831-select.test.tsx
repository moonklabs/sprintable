// @vitest-environment jsdom
//
// story 4831 부품 교체(에이전트 묶음) — 에이전트 목록의 «실행 설정 바꿀 에이전트 고르기» 체크박스가 바탕 Checkbox로 바뀌어도 동작이 그대로여야 한다(story #4540).
// 지키는 것: 관리자에게만, 데스크톱 런타임(claude-code · codex) 행에만 보이는 role=checkbox 바탕 부품이고, 누르거나 스페이스를 치면 «실행 설정 바꾸기 (N)» 단추의 수가 따라 바뀐다.
// 되돌리면(날것 <input>으로) role=checkbox가 사라져 이 시험이 빨개진다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentManagementTab } from './agent-management-tab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const agents = koMessages.agents as unknown as { runProfileBulkOpen: string; runProfileChooseAria: string };
const ariaFor = (name: string) => agents.runProfileChooseAria.replace('{name}', name);

async function mount(role: 'admin' | 'member') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url === '/api/me') return { ok: true, json: async () => ({ data: { role } }) };
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
    if (url.startsWith('/api/team-members?')) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'a1', name: '조사', role: 'member', is_active: true, runtime_type: 'claude-code' },
            { id: 'a2', name: '작성', role: 'member', is_active: true, runtime_type: 'codex' },
            { id: 'a3', name: '검수', role: 'member', is_active: true, runtime_type: 'hermes' }, // not a desktop runtime
          ],
        }),
      };
    }
    return { ok: false, json: async () => null };
  }));
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentManagementTab /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const boxes = () => [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')];
const box = (name: string) => boxes().find((b) => b.getAttribute('aria-label') === ariaFor(name))!;
const bulkButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(agents.runProfileBulkOpen));
const press = async (el: Element, key: string) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  });
};

describe('AgentManagementTab — 실행 설정 고르기 체크박스 (story 4831 부품 교체)', () => {
  it('관리자에게는 데스크톱 런타임 행(claude-code · codex)에만 바탕 Checkbox가 보인다', async () => {
    await mount('admin');
    expect(boxes().map((b) => b.getAttribute('aria-label'))).toEqual([ariaFor('조사'), ariaFor('작성')]);
    expect(boxes().every((b) => b.getAttribute('data-slot') === 'checkbox')).toBe(true);
    expect(bulkButton()).toBeUndefined(); // 고른 것이 없으면 단추도 없다
  });

  it('관리자가 아니면 체크박스가 없다', async () => {
    await mount('member');
    expect(boxes()).toHaveLength(0);
  });

  it('누르면 고른 수가 «실행 설정 바꾸기» 단추에 따라 붙고, 다시 누르면 줄어든다', async () => {
    await mount('admin');
    await act(async () => { box('조사').click(); });
    expect(box('조사').getAttribute('aria-checked')).toBe('true');
    expect(bulkButton()?.textContent).toContain('1');
    await act(async () => { box('작성').click(); });
    expect(bulkButton()?.textContent).toContain('2');
    await act(async () => { box('조사').click(); });
    expect(box('조사').getAttribute('aria-checked')).toBe('false');
    expect(bulkButton()?.textContent).toContain('1');
    await act(async () => { box('작성').click(); });
    expect(bulkButton()).toBeUndefined();
  });

  it('키보드: 스페이스로 고르고, 엔터로는 안 고른다', async () => {
    await mount('admin');
    const b = box('조사');
    b.focus();
    await press(b, 'Enter');
    expect(box('조사').getAttribute('aria-checked')).toBe('false');
    expect(bulkButton()).toBeUndefined();
    await press(b, ' ');
    expect(box('조사').getAttribute('aria-checked')).toBe('true');
    expect(bulkButton()?.textContent).toContain('1');
  });
});
