// @vitest-environment jsdom
//
// story 4677 (UX-1 · P4) AC2 · 유나 §L ⑥a — the four toasts of «이 에이전트가 들어간 프로젝트» come from the messages (they were Korean-only
// «…습니다» strings, so an English screen spoke Korean): put on · taken off · each failing — ko and en, with the project's name.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { AgentProjectAccessSection } from './agent-project-access-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
type Answer = { status: number; body?: unknown };
let post: Answer;
let del: Answer;

const reply = (a: Answer) => new Response(a.body === undefined ? '{}' : JSON.stringify(a.body), { status: a.status });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  post = { status: 201, body: { data: { id: 'r-1' } } };
  del = { status: 200 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/projects/p-1/access/r-1' && init?.method === 'DELETE') return reply(del);
    if (url === '/api/projects/p-1/access' && init?.method === 'POST') return reply(post);
    if (url === '/api/projects/p-1/access') return reply({ status: 200, body: { data: [] } }); // the agent is not on the team yet
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function mount(locale: 'ko' | 'en') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={(locale === 'ko' ? koMessages : enMessages) as never} timeZone="Asia/Seoul">
        <AgentProjectAccessSection agentMemberId="a-1" projects={[{ id: 'p-1', name: '알파' }]} canEdit />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}
const toggle = () => container.querySelector('button') as HTMLButtonElement;
const press = async () => { await act(async () => { toggle().click(); }); for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const toast = () => container.querySelector('[role=status], [role=alert]')?.textContent ?? '';

describe('[SID:4677] ⑥a — the settings section\'s toasts say the team words (ko · en)', () => {
  it('ko: put on → «알파 팀에 넣었어요» · taken off → «알파 팀에서 뺐어요»', async () => {
    await mount('ko');
    expect(toggle().textContent).toBe('안 들어감');
    await press();
    expect(toast()).toBe('알파 팀에 넣었어요');
    expect(toggle().textContent).toBe('들어감');
    await press();
    expect(toast()).toBe('알파 팀에서 뺐어요');
  });

  it('en: put on → «On the 알파 team now» · taken off → «Taken off the 알파 team» (no Korean sentence on an English screen)', async () => {
    await mount('en');
    await press();
    expect(toast()).toBe('On the 알파 team now');
    await press();
    expect(toast()).toBe('Taken off the 알파 team');
  });

  it('a refused put-on / take-off says so in the team words, with «다시 눌러 주세요» / «try again» (ko · en)', async () => {
    post = { status: 500 };
    await mount('ko');
    await press();
    expect(toast()).toBe('알파 팀에 넣지 못했어요 — 다시 눌러 주세요');
    act(() => root.unmount()); root = createRoot(container);
    await mount('en');
    await press();
    expect(toast()).toBe("Couldn't put it on the 알파 team — try again");
    // take-off refused: first make it granted, then fail the DELETE
    post = { status: 201, body: { data: { id: 'r-1' } } };
    del = { status: 500 };
    await press(); // the put-on that works now
    await press(); // the take-off that fails
    expect(toast()).toBe("Couldn't take it off the 알파 team — try again");
    act(() => root.unmount()); root = createRoot(container);
    await mount('ko');
    await press();
    await press();
    expect(toast()).toBe('알파 팀에서 빼지 못했어요 — 다시 눌러 주세요');
  });
});
