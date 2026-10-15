// @vitest-environment jsdom
//
// story 4677 (UX-1 · P4) AC2 · 유나 §L ⑥h — the PROJECT-side settings section (the people): its two success toasts used to be hard-coded
// «{name} 접근 권한 부여됨 / 해제됨» (Korean only — an English screen spoke Korean); they now come from the messages, in the same «이름 · 한 일»
// shape as 4678's putOnTeamDone (no particle · no honorific), and its failures are the ⑥g team words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { ProjectAccessSection } from './project-access-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let grants: { id: string; org_member_id: string; role: string }[];
let postStatus: number;
let deleteStatus: number;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  grants = [];
  postStatus = 201;
  deleteStatus = 200;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
    if (url === '/api/projects/p-1/access-candidates') return json([{ id: 'm-1', user_id: 'u-1', name: '지우', role: 'member' }]);
    if (url === '/api/projects/p-1/access' && init?.method === 'POST') {
      if (postStatus === 201) grants = [{ id: 'g-1', org_member_id: 'm-1', role: 'member' }];
      return json({}, postStatus);
    }
    if (url === '/api/projects/p-1/access/g-1' && init?.method === 'DELETE') {
      if (deleteStatus === 200) grants = [];
      return json({}, deleteStatus);
    }
    if (url === '/api/projects/p-1/access') return json(grants);
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function mount(locale: 'ko' | 'en') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={(locale === 'ko' ? koMessages : enMessages) as never} timeZone="Asia/Seoul">
        <ProjectAccessSection projectId="p-1" />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
}
const toggle = () => container.querySelector('button') as HTMLButtonElement;
const press = async () => { await act(async () => { toggle().click(); }); for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
const toast = () => container.querySelector('[role=status], [role=alert]')?.textContent ?? '';

describe('[SID:4677] ⑥h — the project-side settings section\'s toasts say the team words (ko · en)', () => {
  it('ko: put on → «지우 · 이 프로젝트 팀에 넣었어요» · taken off → «지우 · 이 프로젝트 팀에서 뺐어요»', async () => {
    await mount('ko');
    expect(toggle().textContent).toBe('안 들어감');
    await press();
    expect(toast()).toBe('지우 · 이 프로젝트 팀에 넣었어요');
    expect(toggle().textContent).toBe('들어감');
    await press();
    expect(toast()).toBe('지우 · 이 프로젝트 팀에서 뺐어요');
  });

  it('en: put on → «지우 · On this project\'s team now» · taken off → «지우 · Taken off this project\'s team» (no Korean sentence on an English screen)', async () => {
    await mount('en');
    await press();
    expect(toast()).toBe("지우 · On this project's team now");
    await press();
    expect(toast()).toBe("지우 · Taken off this project's team");
  });

  it('refused put-on / take-off → the ⑥g team words (ko · en)', async () => {
    postStatus = 500;
    await mount('ko');
    await press();
    expect(toast()).toBe('팀에 넣지 못했어요');
    act(() => root.unmount()); root = createRoot(container);
    postStatus = 201;
    await mount('en');
    await press(); // on
    deleteStatus = 500;
    await press(); // take-off refused
    expect(toast()).toBe("Couldn't take off the team");
    act(() => root.unmount()); root = createRoot(container);
    grants = [{ id: 'g-1', org_member_id: 'm-1', role: 'member' }];
    await mount('ko');
    await press();
    expect(toast()).toBe('팀에서 빼지 못했어요');
  });
});
