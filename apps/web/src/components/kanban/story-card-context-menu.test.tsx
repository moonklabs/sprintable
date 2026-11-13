// @vitest-environment jsdom
//
// story #3664(유나 발견 — kanban 카드 컨텍스트 메뉴가 role=menu/menuitem 없는 맨 div body
// portal이라 키보드·스크린리더 도달 0) — role/aria·키보드(Shift+F10 열기·방향키 순회·Enter
// 실행·Esc 닫기+포커스 복귀) 추가분의 회귀가드. story-card.test.tsx는 renderToStaticMarkup만
// 써(정적 렌더 전용 기존 관례) 상호작용 테스트가 안 된다 — 이 파일이 별도로 createRoot+act
// (kanban-board.test.tsx와 동형 관례)를 쓴다. 기존 우클릭·좌표·항목 구성은 무변경(회귀 1건).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DndContext } from '@dnd-kit/core';
import koMessages from '../../../messages/ko.json';
import { StoryCard } from './story-card';
import type { KanbanStory } from './types';

function makeStory(overrides: Partial<KanbanStory> = {}): KanbanStory {
  return {
    id: 's1', story_number: 1, title: 'Story', status: 'in-progress', priority: 'medium',
    story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
    description: null, acceptance_criteria: null, attachments: null, position: null,
    success_hypothesis: null, metric_definition: null, measure_after: null,
    outcome_status: 'n_a', outcome_result: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

function renderCard(props: Partial<Parameters<typeof StoryCard>[0]> = {}) {
  const onEdit = props.onEdit ?? vi.fn();
  const onChangeStatus = props.onChangeStatus ?? vi.fn();
  const onAssign = props.onAssign ?? vi.fn();
  const onDelete = props.onDelete ?? vi.fn();
  act(() => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DndContext>
          <StoryCard
            story={makeStory()}
            assignees={[]}
            onClick={() => {}}
            onEdit={onEdit}
            onChangeStatus={onChangeStatus}
            onAssign={onAssign}
            onDelete={onDelete}
            {...props}
          />
        </DndContext>
      </NextIntlClientProvider>,
    );
  });
  return { onEdit, onChangeStatus, onAssign, onDelete };
}

function getCard(): HTMLElement {
  const card = container.querySelector('[aria-haspopup="menu"]');
  if (!card) throw new Error('card(트리거) not found');
  return card as HTMLElement;
}

function openViaContextMenu() {
  const card = getCard();
  act(() => {
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
  });
}

describe('StoryCard 컨텍스트 메뉴 — story #3664 AC1(role/aria)', () => {
  it('트리거(카드)에 aria-haspopup=menu·닫혀 있으면 aria-expanded=false', () => {
    renderCard();
    const card = getCard();
    expect(card.getAttribute('aria-haspopup')).toBe('menu');
    expect(card.getAttribute('aria-expanded')).toBe('false');
  });

  it('우클릭으로 열면 메뉴 컨테이너 role=menu·항목들 role=menuitem·트리거 aria-expanded=true', () => {
    renderCard();
    openViaContextMenu();

    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const items = document.body.querySelectorAll('[role="menu"] [role="menuitem"]');
    // editStory·assignMember·deleteStory — 3개(상태는 4908부터 메뉴 안 칩 5개: role=menuitemradio).
    expect(items.length).toBe(3);
    expect(document.body.querySelectorAll('[role="menu"] [role="menuitemradio"]').length).toBe(5);
    expect(getCard().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('StoryCard 컨텍스트 메뉴 — story #3664 AC2(키보드)', () => {
  it('Shift+F10으로 카드에서 메뉴가 열린다', () => {
    renderCard();
    const card = getCard();
    act(() => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('메뉴가 열리면 첫 항목(role=menuitem)으로 포커스가 옮겨진다', () => {
    renderCard();
    openViaContextMenu();
    const firstItem = document.body.querySelector('[role="menu"] [role="menuitem"]');
    expect(document.activeElement).toBe(firstItem);
  });

  it('ArrowDown/ArrowUp이 role=menuitem 사이를 순회한다(wrap 포함)', () => {
    renderCard();
    openViaContextMenu();
    // 위/아래는 칩도 한 칸씩 지난다(DOM 순서: 수정 → 칩 5 → 담당자 → 삭제).
    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]'));
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;

    expect(items).toHaveLength(8);
    expect(document.activeElement).toBe(items[0]);
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(items[1]);

    // 맨 위에서 ArrowUp → wrap해서 마지막 항목으로.
    act(() => {
      items[0]!.focus();
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('Enter로 포커스된 항목이 실행된다(네이티브 버튼 활성화)', () => {
    const { onEdit } = renderCard();
    openViaContextMenu();
    const firstItem = document.body.querySelector('[role="menu"] [role="menuitem"]') as HTMLButtonElement;
    expect(document.activeElement).toBe(firstItem);
    // jsdom은 버튼에 Enter keydown을 걸어도 click을 자동 합성하지 않는다(브라우저와의 알려진
    // 차이) — 네이티브 활성화 자체는 UA 계약이라 여기서는 "포커스가 옳은 항목에 있다"를
    // 확認한 뒤, 실제 활성화는 click으로 재현한다(핸들러 wiring이 옳다는 증거로 충분).
    act(() => { firstItem.click(); });
    expect(onEdit).toHaveBeenCalledWith('s1');
  });

  it('Esc로 메뉴가 닫히고 포커스가 카드로 되돌아간다', () => {
    renderCard();
    const card = getCard();
    openViaContextMenu();
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(card);
  });
});

function chips(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitemradio"]'));
}

describe('StoryCard 컨텍스트 메뉴 — 4908 상태 칩 한 줄(예전 «상태 변경 ▸» 하위 메뉴 대체)', () => {
  it('⭐칩 5개가 이름 있는 그룹(상태 변경) 안에 서고 하위 메뉴는 없다 — 우클릭 뒤 [role=menu]는 하나뿐', () => {
    renderCard();
    openViaContextMenu();
    const group = document.body.querySelector('[role="menu"] [role="group"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toBe(koMessages.board.changeStatus);
    expect(chips().map((c) => c.getAttribute('data-status-chip'))).toEqual(['backlog', 'ready-for-dev', 'in-progress', 'in-review', 'done']);
    expect(document.body.querySelectorAll('[role="menu"]').length).toBe(1);
    expect(document.body.querySelector('[aria-haspopup="menu"][role="menuitem"]')).toBeNull();
  });

  it('⭐지금 상태 칩만 aria-checked=true + ✓ 표시 — 색만으로 알리지 않는다', () => {
    renderCard();
    openViaContextMenu();
    const states = chips().map((c) => [c.getAttribute('data-status-chip'), c.getAttribute('aria-checked')]);
    expect(states).toEqual([['backlog', 'false'], ['ready-for-dev', 'false'], ['in-progress', 'true'], ['in-review', 'false'], ['done', 'false']]);
    const current = chips().find((c) => c.getAttribute('aria-checked') === 'true')!;
    expect(current.querySelector('svg')).not.toBeNull();
    expect(chips().filter((c) => c.querySelector('svg')).length).toBe(1);
  });

  it('⭐우클릭 → 칩 한 번(두 번 눌러) 상태가 바뀐다: onChangeStatus(스토리, 상태) · 메뉴는 닫히고 초점은 카드로', () => {
    const { onChangeStatus } = renderCard();
    const card = getCard();
    openViaContextMenu();
    act(() => { chips().find((c) => c.getAttribute('data-status-chip') === 'in-review')!.click(); });
    expect(onChangeStatus).toHaveBeenCalledTimes(1);
    expect(onChangeStatus).toHaveBeenCalledWith('s1', 'in-review');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it('지금 상태 칩을 누르면 바꾸지 않고(요청 0) 메뉴만 닫는다', () => {
    const { onChangeStatus } = renderCard();
    openViaContextMenu();
    act(() => { chips().find((c) => c.getAttribute('aria-checked') === 'true')!.click(); });
    expect(onChangeStatus).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it('⭐←/→는 칩 사이를 오가고 양 끝에서 반대 끝으로 돈다', () => {
    renderCard();
    openViaContextMenu();
    const cs = chips();
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    const press = (key: string) => act(() => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
    void menu;
    act(() => { cs[0]!.focus(); });
    press('ArrowRight');
    expect(document.activeElement).toBe(cs[1]);
    press('ArrowLeft');
    press('ArrowLeft');
    expect(document.activeElement).toBe(cs[4]);
    press('ArrowRight');
    expect(document.activeElement).toBe(cs[0]);
  });

  it('칩이 아닌 항목에서 ←/→는 아무 일도 없다(초점 그대로)', () => {
    renderCard();
    openViaContextMenu();
    const first = document.body.querySelector('[role="menu"] [role="menuitem"]') as HTMLElement;
    expect(document.activeElement).toBe(first);
    act(() => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(first);
  });

  it('↑/↓로 칩 줄에서 이웃 항목(담당자 · 수정)으로 나갈 수 있다', () => {
    renderCard();
    openViaContextMenu();
    const cs = chips();
    act(() => { cs[4]!.focus(); });
    act(() => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    expect((document.activeElement as HTMLElement).getAttribute('role')).toBe('menuitem');
    expect(document.activeElement?.textContent).toContain(koMessages.board.assignMember);
  });

  it('Esc는 메뉴 전체를 닫고 초점을 카드로 되돌린다(하위 메뉴가 없으니 «한 층»뿐)', () => {
    renderCard();
    const card = getCard();
    openViaContextMenu();
    act(() => { chips()[0]!.focus(); });
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it('⭐잠긴(파생) 열 카드는 칩 줄이 없다 — 막힘 그대로', () => {
    renderCard({ locked: true } as Partial<Parameters<typeof StoryCard>[0]>);
    openViaContextMenu();
    expect(chips()).toHaveLength(0);
    expect(document.body.querySelector('[role="group"]')).toBeNull();
  });

  it('onChangeStatus가 없으면 칩 줄이 없다', () => {
    renderCard({ onChangeStatus: undefined });
    openViaContextMenu();
    expect(chips()).toHaveLength(0);
  });
});

describe('StoryCard 컨텍스트 메뉴 — story #3664 회귀(기존 우클릭·좌표·항목)', () => {
  it('우클릭 좌표가 메뉴 위치(top/left)로 그대로 쓰인다(기존 동작 무변)', () => {
    renderCard();
    const card = getCard();
    act(() => {
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 123, clientY: 45 }));
    });
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.style.top).toBe('45px');
    expect(menu.style.left).toBe('123px');
  });

  it('항목 3종(수정·담당자 지정·삭제)이 클릭으로 각자의 콜백을 부른다(상태는 칩 — 위 describe)', () => {
    const { onEdit, onAssign, onDelete } = renderCard();
    openViaContextMenu();
    const items = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]'));
    expect(items).toHaveLength(3);

    act(() => { items[0]!.click(); });
    expect(onEdit).toHaveBeenCalledWith('s1');

    openViaContextMenu();
    const itemsAfterReopen = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]'));
    act(() => { itemsAfterReopen[1]!.click(); }); // assignMember(2번째)
    expect(onAssign).toHaveBeenCalledWith('s1');

    openViaContextMenu();
    const itemsAfterReopen2 = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]'));
    act(() => { itemsAfterReopen2[2]!.click(); }); // deleteStory(3번째) — ConfirmDialog를 연다(실 삭제 아님).
    expect(onDelete).not.toHaveBeenCalled();
  });
});
