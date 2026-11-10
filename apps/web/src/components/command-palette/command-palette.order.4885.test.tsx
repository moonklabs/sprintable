// @vitest-environment jsdom
//
// story #4885 (UI-2 AC3 §5 · AC4) — ⌘K «이동» 목록은 길잡이와 같은 순서다: 홈 · 대화 · 일감(+ 그 탭 앵커) · 팀 · 지식 · 조직 · 설정 · 전체 · 그 밖.
// 예전엔 대화가 목록 맨 끝(25번째쯤)이었다. 목적지는 늘리지 않는다 — 길잡이에 있고 여기 없던 «전체»(/more)만 더했다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { CommandPalette, deriveNavigateItems } from './command-palette';
import { ALL_SCREENS_ITEM, NAV_GROUPS, OTHER_NAV_ITEMS, CHAT_CENTER_ITEM } from '@/lib/nav-config';
import koMessagesRaw from '../../../messages/ko.json';

type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ids = () => deriveNavigateItems((resource) => `/ws/proj/${resource}`).map((item) => item.id);

describe('⌘K 이동 목록 순서 = 길잡이 순서 (story #4885)', () => {
  // 순서를 손으로 적지 않는다 — 길잡이 설정(nav-config)에서 읽어, 길잡이가 바뀌면 이 시험의 기대도 같이 바뀐다(팔레트만 옛 순서로 남으면 RED).
  // 길잡이(app-sidebar)의 줄 순서 = 첫 구역(홈) → 챗 center → 나머지 구역 → «전체»(ALL_SCREENS_ITEM) → 그 밖(OTHER_NAV_ITEMS). 일감 탭 앵커는 일감 바로 뒤.
  function sidebarOrder(): string[] {
    const [first, ...rest] = NAV_GROUPS;
    const order = [
      ...first!.items.map((i) => i.id),
      CHAT_CENTER_ITEM.id,
      ...rest.flatMap((g) => g.items.map((i) => i.id)),
      ALL_SCREENS_ITEM.id,
      ...OTHER_NAV_ITEMS.map((i) => i.id),
    ];
    const board = order.indexOf('board');
    return [...order.slice(0, board + 1), ...ANCHORS, ...order.slice(board + 1)];
  }
  const ANCHORS = ['go-sprints', 'go-epics', 'go-retro', 'go-work-list', 'go-hypotheses'];

  it('⭐팔레트 «이동» 순서 전체가 길잡이 설정(nav-config)에서 읽은 순서와 같다 — 대화는 홈·결재 바로 다음', () => {
    expect(ids()).toEqual(sidebarOrder());
    expect(ids().indexOf('chats')).toBe(NAV_GROUPS[0]!.items.length);
  });

  it('길잡이 구역 순서(팀 → 지식 → 조직 → 설정)를 그대로 따르고, «전체»는 설정 바로 뒤 · «그 밖»보다 앞이다', () => {
    const list = ids();
    const firstOf = (groupId: string) => list.indexOf(NAV_GROUPS.find((g) => g.id === groupId)!.items[0]!.id);
    expect(firstOf('dev')).toBeLessThan(firstOf('team'));
    expect(firstOf('team')).toBeLessThan(firstOf('knowledge'));
    expect(firstOf('knowledge')).toBeLessThan(firstOf('org'));
    expect(firstOf('org')).toBeLessThan(firstOf('settings'));
    expect(list.indexOf('settings') + 1).toBe(list.indexOf('all-screens'));
    expect(list.indexOf('all-screens')).toBeLessThan(list.indexOf(OTHER_NAV_ITEMS[0]!.id));
  });

  it('목적지 집합은 길잡이 + 챗 + 그 밖 + «전체» + 앵커 5 — 빠지거나 겹치는 것이 없다', () => {
    const list = ids();
    expect(new Set(list).size).toBe(list.length);
    const expected = new Set([
      ...NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id)),
      ...OTHER_NAV_ITEMS.map((i) => i.id),
      CHAT_CENTER_ITEM.id,
      'all-screens',
      'go-sprints', 'go-epics', 'go-retro', 'go-work-list', 'go-hypotheses',
    ]);
    expect(new Set(list)).toEqual(expected);
  });

  it('«전체»는 워크스페이스 없는 /more 로 간다', () => {
    const all = deriveNavigateItems((resource) => `/ws/proj/${resource}`).find((i) => i.id === 'all-screens');
    expect(all).toMatchObject({ href: '/more', isWorkspaceless: true });
  });
});

describe('⌘K 이동 목록 — 실제 렌더 순서', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as unknown as typeof fetch);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('맨 위 세 줄이 홈 · 결재 · 대화이고, «전체로 이동»이 그려진다', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <CommandPalette open onOpenChange={vi.fn()} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const commandIds = [...document.querySelectorAll('[data-command-id]')].map((el) => el.getAttribute('data-command-id'));
    expect(commandIds.slice(0, 3)).toEqual(['org-briefing', 'inbox', 'chats']);
    expect(document.body.textContent).toContain('전체로 이동');
  });
});
