// @vitest-environment jsdom
//
// story 4906 (defect ① of the customer lap) — a new organization's first conversation was a dead end: the list said «start a new conversation», the «새 대화» window listed nobody
// (0 rows, «대화 시작» off) and nothing said what to do next. With nobody but me to talk to, both places now say so and link to the screens that make somebody to talk to
// (add an agent · invite a teammate — existing screens, no new feature); a plain member is told who can (no link they cannot use). An unanswered or failed roster read is NOT «nobody».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { NewConversationModal } from './new-conversation-modal';
import { ChatListEmptyState } from './no-peers-next-steps';
import { DashboardCtx } from '@/app/dashboard/dashboard-shell';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const ME = 'human-me';
const ORG = 'org-1';
const PROJECT = { projectId: 'proj-a', projectName: '프로젝트 에이' };
const ME_ROW = { id: ME, name: '내이름', type: 'human' };
const BOT_ROW = { id: 'a-bot', name: '점검봇', type: 'agent' };
const SYSTEM_ROW = { id: 'sys', name: '시스템 발행', type: 'agent', runtime_type: 'system-publisher' };

type Roster = Array<Record<string, unknown>>;
/** the roster read: an array answers · 'fail' answers 500 · 'never' never answers */
function stubFetch(roster: Roster | 'fail' | 'never') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/members')) {
      if (roster === 'never') return new Promise(() => {});
      if (roster === 'fail') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ data: roster }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

async function mount(node: React.ReactNode, role: 'owner' | 'admin' | 'member', projects: unknown[] = [PROJECT], extraCtx: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DashboardCtx.Provider value={{ projectMemberships: projects, currentTeamMemberId: ME, orgId: ORG, orgMemberships: [{ orgId: ORG, role }], ...extraCtx } as never}>
          {node}
        </DashboardCtx.Provider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const modal = () => <NewConversationModal projectId="proj-a" onClose={() => {}} onCreated={() => {}} />;
const q = (testid: string) => document.body.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
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

describe('«새 대화» window — nobody but me', () => {
  it('⭐an owner sees the sentence and both links (add an agent · invite a teammate) instead of an empty list; «대화 시작» stays off', async () => {
    stubFetch([ME_ROW]);
    await mount(modal(), 'owner');
    expect(q('chat-no-peers')).not.toBeNull();
    expect(document.body.textContent).toContain(koMessages.chats.noPeersBody);
    expect(q('chat-no-peers-add-agent')!.getAttribute('href')).toContain('/organization/workforce?tab=recruit');
    expect(q('chat-no-peers-invite')!.getAttribute('href')).toContain('/organization/members');
    expect(createBtn().disabled).toBe(true);
  });

  it('⭐the system publisher is not somebody to talk to: me + the system publisher is still «nobody»', async () => {
    stubFetch([ME_ROW, SYSTEM_ROW]);
    await mount(modal(), 'admin');
    expect(q('chat-no-peers')).not.toBeNull();
  });

  it('⭐a plain member is told who can add somebody — the sentence, no link they cannot use', async () => {
    stubFetch([ME_ROW]);
    await mount(modal(), 'member');
    expect(q('chat-no-peers')).not.toBeNull();
    expect(document.body.textContent).toContain(koMessages.chats.noPeersBodyMember);
    expect(q('chat-no-peers-add-agent')).toBeNull();
    expect(q('chat-no-peers-invite')).toBeNull();
  });

  it('⭐with somebody to talk to the window is as before: their row, no next steps', async () => {
    stubFetch([ME_ROW, BOT_ROW]);
    await mount(modal(), 'owner');
    expect(q('chat-no-peers')).toBeNull();
    expect([...document.body.querySelectorAll('button')].some((b) => b.textContent?.includes('점검봇'))).toBe(true);
  });

  it('⭐a roster read that FAILED is not «nobody» — no next steps are claimed', async () => {
    stubFetch('fail');
    await mount(modal(), 'owner');
    expect(q('chat-no-peers')).toBeNull();
  });
});

describe('list rail empty state', () => {
  it('⭐nobody but me: the description says so and the owner gets both links (not «새 대화를 시작해보세요», which led nowhere)', async () => {
    stubFetch([ME_ROW]);
    await mount(<ChatListEmptyState />, 'owner');
    expect(document.body.textContent).toContain(koMessages.chats.noConversations);
    expect(document.body.textContent).toContain(koMessages.chats.noPeersBody);
    expect(document.body.textContent).not.toContain(koMessages.chats.startNewConversation);
    expect(q('chat-no-peers-add-agent')).not.toBeNull();
    expect(q('chat-no-peers-invite')).not.toBeNull();
    // the sentence is said ONCE (the empty state draws it as its description, the links block does not repeat it)
    expect(document.body.textContent!.split(koMessages.chats.noPeersBody).length - 1).toBe(1);
  });

  it('⭐the system publisher does not count as somebody here either: me + the system publisher is «nobody»', async () => {
    stubFetch([ME_ROW, SYSTEM_ROW]);
    await mount(<ChatListEmptyState />, 'owner');
    expect(q('chat-no-peers-add-agent')).not.toBeNull();
  });

  it('⭐a member: the sentence for members, no links', async () => {
    stubFetch([ME_ROW]);
    await mount(<ChatListEmptyState />, 'member');
    expect(document.body.textContent).toContain(koMessages.chats.noPeersBodyMember);
    expect(q('chat-no-peers-add-agent')).toBeNull();
  });

  it('⭐somebody is there: the ordinary «새 대화를 시작해보세요», no links', async () => {
    stubFetch([ME_ROW, BOT_ROW]);
    await mount(<ChatListEmptyState />, 'owner');
    expect(document.body.textContent).toContain(koMessages.chats.startNewConversation);
    expect(q('chat-no-peers-add-agent')).toBeNull();
  });

  it('⭐an unanswered read or a failed one is not «nobody»: the ordinary empty state stays', async () => {
    stubFetch('never');
    await mount(<ChatListEmptyState />, 'owner');
    expect(document.body.textContent).toContain(koMessages.chats.startNewConversation);
    expect(q('chat-no-peers-add-agent')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    stubFetch('fail');
    await mount(<ChatListEmptyState />, 'owner');
    expect(document.body.textContent).toContain(koMessages.chats.startNewConversation);
    expect(q('chat-no-peers-add-agent')).toBeNull();
  });
});

describe('a new organization with no project yet', () => {
  it('⭐an owner is sent straight to where a project is made (an agent belongs to one) — not to the recruit tab that would only send them there; inviting stays', async () => {
    stubFetch([ME_ROW]);
    await mount(<ChatListEmptyState />, 'owner', []);
    expect(document.body.textContent).toContain(koMessages.chats.noPeersBodyNoProject);
    expect(q('chat-no-peers-create-project')!.getAttribute('href')).toContain('/settings?tab=projects');
    expect(q('chat-no-peers-create-project')!.getAttribute('href')).toContain('return=chats'); // the project made there sends the person back to the list
    expect(q('chat-no-peers-add-agent')).toBeNull();
    expect(q('chat-no-peers-invite')!.getAttribute('href')).toContain('/organization/members');
  });

  it('⭐the «새 대화» window says the same', async () => {
    stubFetch([ME_ROW]);
    await mount(modal(), 'owner', []);
    expect(q('chat-no-peers-create-project')).not.toBeNull();
  });

  it('⭐a member with no project is told who can, no link', async () => {
    stubFetch([ME_ROW]);
    await mount(<ChatListEmptyState />, 'member', []);
    expect(document.body.textContent).toContain(koMessages.chats.noPeersBodyMember);
    expect(q('chat-no-peers-create-project')).toBeNull();
  });

  it('⭐a read of the projects that FAILED is not «no project»: no claim, no link to create one — the recruit tab (which tells the failed state apart) is the way', async () => {
    stubFetch([ME_ROW]);
    await mount(<ChatListEmptyState />, 'owner', [], { projectMembershipsFailed: true });
    expect(q('chat-no-peers-create-project')).toBeNull();
    expect(document.body.textContent).not.toContain(koMessages.chats.noPeersBodyNoProject);
    expect(q('chat-no-peers-add-agent')).not.toBeNull();
  });
});
