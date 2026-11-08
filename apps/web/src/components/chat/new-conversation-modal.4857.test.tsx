// @vitest-environment jsdom
//
// story 4857 — the people to pick from in «new conversation» are everybody in the organization EXCEPT me: the shared roster lists me too
// (it feeds assignee · mention pickers), and a room needs somebody else.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { NewConversationModal } from './new-conversation-modal';
import { DashboardCtx } from '@/app/dashboard/dashboard-shell';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const A = { projectId: 'proj-a', projectName: '프로젝트 에이' };
const ME = 'human-me';
const ROSTER = [
  { id: ME, name: '내이름', type: 'human' },
  { id: 'human-other', name: '다른사람', type: 'human' },
  { id: 'a-bot', name: '점검봇', type: 'agent' },
];

function mockFetches(roster: typeof ROSTER, posts: unknown[]) {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: roster }) };
    if (url === '/api/conversations' && init?.method === 'POST') {
      posts.push(JSON.parse(init.body!));
      return { ok: true, json: async () => ({ id: 'new-room' }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

async function mount(fetchMock: ReturnType<typeof vi.fn>, currentTeamMemberId: string | undefined) {
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DashboardCtx.Provider value={{ projectMemberships: [A], currentTeamMemberId } as never}>
          <NewConversationModal projectId="proj-a" onClose={() => {}} onCreated={() => {}} />
        </DashboardCtx.Provider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const rowNames = () => ['내이름', '다른사람', '점검봇'].filter((n) => [...document.body.querySelectorAll('button')].some((b) => b.textContent?.includes(n)));
const btn = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(name))!;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
const createBtn = () => [...document.body.querySelectorAll('button')].find((b) => b.textContent === koMessages.chats.create) as HTMLButtonElement;

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

describe('NewConversationModal — 나 자신은 상대 목록에 없다(story 4857)', () => {
  it('⭐내 id의 행은 안 그리고, 다른 사람 · 에이전트는 그대로 그린다', async () => {
    await mount(mockFetches(ROSTER, []), ME);
    expect(rowNames()).toEqual(['다른사람', '점검봇']);
  });

  it('⭐고르는 길은 그대로 — 다른 사람을 골라 만들면 참가자는 그 사람뿐(나는 서버가 더함)', async () => {
    const posts: unknown[] = [];
    await mount(mockFetches(ROSTER, posts), ME);
    await click(btn('다른사람'));
    await click(createBtn());
    expect(posts).toEqual([{ type: 'dm', title: null, participant_ids: ['human-other'], project_id: 'proj-a' }]);
  });

  it('⭐둘 이상 골라 모임방을 만들어도 참가자에 내 id는 없다', async () => {
    const posts: unknown[] = [];
    await mount(mockFetches(ROSTER, posts), ME);
    await click(btn('다른사람'));
    await click(btn('점검봇'));
    await click(createBtn());
    expect(posts).toHaveLength(1);
    const body = posts[0] as { type: string; participant_ids: string[] };
    expect(body.type).toBe('group');
    expect(body.participant_ids.sort()).toEqual(['a-bot', 'human-other']);
  });

  it('⭐나밖에 없는 조직이면 고를 사람이 없어 만들 수 없다', async () => {
    const posts: unknown[] = [];
    await mount(mockFetches([ROSTER[0]!], posts), ME);
    expect(rowNames()).toEqual([]);
    expect(createBtn().disabled).toBe(true);
    await click(createBtn());
    expect(posts).toEqual([]);
  });

  it('⭐내 행을 뺀 뒤에 이름 겹침을 센다 — 이름 없는 사람이 나와 상대 둘이어도 상대 행에 «· ID» 꼬리가 안 붙는다', async () => {
    const roster = [{ id: 'unnamed-me-1234', name: '', type: 'human' }, { id: 'unnamed-other-5678', name: '', type: 'human' }] as unknown as typeof ROSTER;
    await mount(mockFetches(roster, []), 'unnamed-me-1234');
    const rows = [...document.body.querySelectorAll('li button')];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).not.toMatch(/unnamed-/);
  });

  it('내 id로 거른다(사람인지 에이전트인지 따지지 않는다)', async () => {
    await mount(mockFetches(ROSTER, []), 'a-bot');
    expect(rowNames()).toEqual(['내이름', '다른사람']);
  });

  it('내가 누군지 아직 모르면(id 없음) 목록을 건드리지 않는다', async () => {
    await mount(mockFetches(ROSTER, []), undefined);
    expect(rowNames()).toEqual(['내이름', '다른사람', '점검봇']);
  });
});
