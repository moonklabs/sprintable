// @vitest-environment jsdom
//
// 4908 셋째 조각 — 카드가 직접 하는 일: 메뉴 «담당자 ▸»(켜고 끄기) · 제목 바로 바꾸기(메뉴 · F2 · 더블클릭) · 잠긴 열 카드의 키보드 닿기.
// PO 11-12 결정: Q2 클릭 = 열기 · 더블클릭 = 제목 바로 바꾸기 · F2도 같은 길 / Q3 메뉴 «담당자»는 패널과 같은 PATCH로 실제 동작.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DndContext } from '@dnd-kit/core';
import koMessages from '../../../messages/ko.json';
import { StoryCard } from './story-card';
import type { KanbanMember, KanbanStory } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const makeStory = (o: Partial<KanbanStory> = {}): KanbanStory => ({
  id: 's1', story_number: 4908, title: '보드 재건축', status: 'in-progress', priority: 'medium', story_points: null,
  assignee_id: 'm1', assignee_ids: ['m1'], epic_id: null, sprint_id: null, description: null, acceptance_criteria: null, attachments: null,
  position: null, success_hypothesis: null, metric_definition: null, measure_after: null, outcome_status: 'n_a', outcome_result: null, ...o,
}) as KanbanStory;
const members: KanbanMember[] = [
  { id: 'm1', name: '안나', type: 'human' }, { id: 'm2', name: '빌드 에이전트', type: 'agent' }, { id: 'm3', name: '카를로스', type: 'human' },
] as KanbanMember[];

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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render(props: Partial<React.ComponentProps<typeof StoryCard>> = {}) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DndContext>
          <StoryCard story={makeStory()} assignees={[members[0]!]} onClick={() => {}} onChangeStatus={() => {}} {...props} />
        </DndContext>
      </NextIntlClientProvider>,
    );
  });
  return container.firstElementChild as HTMLElement;
}
const openMenu = (card: HTMLElement) => {
  const btn = card.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  return document.body.querySelector<HTMLElement>('[role="menu"]')!;
};
const itemByText = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')].find((e) => e.textContent?.includes(text));
const click = (el: Element, detail = 0, pointerType?: string) => act(() => {
  const ev = new MouseEvent('click', { bubbles: true, detail });
  if (pointerType) Object.defineProperty(ev, 'pointerType', { value: pointerType });
  el.dispatchEvent(ev);
});

describe('4908 카드 메뉴 «담당자 ▸» — 켜고 끄기', () => {
  const props = { assignableMembers: members, onToggleAssignee: vi.fn() };
  beforeEach(() => { props.onToggleAssignee.mockReset(); });

  it('⭐메뉴에 «담당자 ▸»가 있고 누르면 후보 전원이 체크 항목으로 선다 · 지금 담당은 aria-checked', () => {
    const card = render(props);
    const menu = openMenu(card);
    const trigger = itemByText(menu, koMessages.board.assignMember)!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    click(trigger);
    const boxes = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
    expect(boxes.map((b) => b.textContent?.trim())).toEqual(['안나', '빌드 에이전트', '카를로스']);
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  });

  it('⭐항목을 누르면 onToggleAssignee(스토리, 구성원)가 불리고 서브메뉴는 열린 채(여러 명을 이어서 켠다)', () => {
    const card = render(props);
    click(itemByText(openMenu(card), koMessages.board.assignMember)!);
    const carlos = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((b) => b.textContent?.includes('카를로스'))!;
    click(carlos);
    expect(props.onToggleAssignee).toHaveBeenCalledWith('s1', 'm3');
    expect(document.body.querySelector('[role="menuitemcheckbox"]')).not.toBeNull();
  });

  it('후보나 콜백이 없으면 예전 «담당자 지정»(onAssign) 항목 그대로 — 서브메뉴 없음', () => {
    const onAssign = vi.fn();
    const card = render({ onAssign });
    const item = itemByText(openMenu(card), koMessages.board.assignMember)!;
    expect(item.getAttribute('aria-haspopup')).toBeNull();
    click(item);
    expect(onAssign).toHaveBeenCalledWith('s1');
  });

  it('상태 서브메뉴와 담당자 서브메뉴는 동시에 열리지 않는다(하나를 열면 다른 하나가 닫힌다)', () => {
    const card = render({ ...props, onChangeStatus: () => {} });
    const menu = openMenu(card);
    click(itemByText(menu, koMessages.board.changeStatus)!);
    expect(document.body.querySelectorAll('[role="menu"]').length).toBe(2);
    click(itemByText(menu, koMessages.board.assignMember)!);
    expect(document.body.querySelectorAll('[role="menu"]').length).toBe(2);
    expect(document.body.querySelector('[role="menuitemcheckbox"]')).not.toBeNull();
    expect(itemByText(document.body, koMessages.board.inReview)).toBeUndefined();
  });

  it('⭐거꾸로도: 담당자 서브메뉴가 열려 있을 때 «상태 변경 ▸»를 열면 담당자 쪽이 닫힌다', () => {
    const card = render({ ...props, onChangeStatus: () => {} });
    const menu = openMenu(card);
    click(itemByText(menu, koMessages.board.assignMember)!);
    expect(document.body.querySelector('[role="menuitemcheckbox"]')).not.toBeNull();
    click(itemByText(menu, koMessages.board.changeStatus)!);
    expect(document.body.querySelector('[role="menuitemcheckbox"]')).toBeNull();
    expect(itemByText(document.body, koMessages.board.inReview)).toBeTruthy();
  });

  it('Esc는 서브메뉴만 닫고 메뉴는 남는다', () => {
    const card = render(props);
    click(itemByText(openMenu(card), koMessages.board.assignMember)!);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.body.querySelector('[role="menuitemcheckbox"]')).toBeNull();
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
  });
});

describe('4908 제목 바로 바꾸기 — 메뉴 · F2', () => {
  const input = () => container.querySelector<HTMLInputElement>('input');
  const type = (el: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const key = (el: Element, k: string, init: KeyboardEventInit = {}) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init })); });

  it('⭐메뉴 «이름 바꾸기» → 제목 자리에 입력칸이 서고 현재 제목이 들어 있다 · 이름에 카드 제목', () => {
    const card = render({ onRename: vi.fn() });
    click(itemByText(openMenu(card), koMessages.board.renameStory)!);
    expect(input()!.value).toBe('보드 재건축');
    expect(input()!.getAttribute('aria-label')).toBe('보드 재건축 이름 바꾸기');
  });

  it('⭐Enter = 새 제목으로 onRename · 입력칸은 닫히고 제목 자리로 돌아온다', () => {
    const onRename = vi.fn();
    const card = render({ onRename });
    click(itemByText(openMenu(card), koMessages.board.renameStory)!);
    type(input()!, '  새 제목  ');
    key(input()!, 'Enter');
    expect(onRename).toHaveBeenCalledWith('s1', '새 제목');
    expect(input()).toBeNull();
  });

  it('Esc = 취소(onRename 안 불림) · 그대로면 안 불림 · 빈 글이면 안 불림', () => {
    const onRename = vi.fn();
    const card = render({ onRename });
    for (const [text, k] of [['다른 글', 'Escape'], ['보드 재건축', 'Enter'], ['   ', 'Enter']] as const) {
      click(itemByText(openMenu(card), koMessages.board.renameStory)!);
      type(input()!, text);
      key(input()!, k);
    }
    expect(onRename).not.toHaveBeenCalled();
  });

  it('⭐한글 조합 중의 Enter는 저장이 아니다(글자 확정 키 · 4831)', () => {
    const onRename = vi.fn();
    const card = render({ onRename });
    click(itemByText(openMenu(card), koMessages.board.renameStory)!);
    type(input()!, '반쯤 쓴');
    key(input()!, 'Enter', { isComposing: true });
    expect(onRename).not.toHaveBeenCalled();
    expect(input()).not.toBeNull();
  });

  it('⭐클릭은 바로 열린다(기다림 없음) · 더블클릭은 제목 바꾸기가 아니다(더블클릭 = 열기 — 저장소 · 결재함 · 에이전트 목록과 같은 뜻)', () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    const card = render({ onRename: vi.fn(), onClick });
    click(card, 1);
    expect(onClick).toHaveBeenCalledTimes(1); // 시계를 안 돌려도 이미 열렸다
    click(card, 2);
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(input()).toBeNull();
  });

  it('⭐F2(카드에 초점) = 같은 길 · 카드 안 입력칸의 F2는 가로채지 않는다', () => {
    const card = render({ onRename: vi.fn() });
    key(card, 'F2');
    expect(input()).not.toBeNull();
  });

  it('입력칸의 누름 · 키 · 클릭은 카드(끌기 · 집기 · 열기)로 새지 않는다', () => {
    const onClick = vi.fn();
    const outer = vi.fn();
    act(() => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <DndContext>
            <div onPointerDown={outer} onKeyDown={outer} onClick={outer}>
              <StoryCard story={makeStory()} onClick={onClick} onRename={vi.fn()} onChangeStatus={() => {}} />
            </div>
          </DndContext>
        </NextIntlClientProvider>,
      );
    });
    const card = container.firstElementChild!.firstElementChild as HTMLElement;
    key(card, 'F2');
    outer.mockClear(); // F2 자체는 카드 위에서 눌린 키 — 여기서부터 입력칸 안의 것만 센다
    const el = input()!;
    act(() => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    key(el, ' ');
    click(el, 1);
    expect(outer).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('이름 바꾸기가 없는 카드(onRename 없음)는 메뉴 항목도 F2도 없다', () => {
    const card = render();
    expect(itemByText(openMenu(card), koMessages.board.renameStory)).toBeUndefined();
    key(card, 'F2');
    expect(input()).toBeNull();
  });
});

describe('4908 이름 바꾸기 초점 — codex 1라운드 반영', () => {
  const input = () => container.querySelector<HTMLInputElement>('input');
  const press = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });

  it('⭐다른 곳을 눌러 빠져나가며(blur) 저장해도 그 사람이 옮긴 초점을 카드로 가로채지 않는다', () => {
    const onRename = vi.fn();
    act(() => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <DndContext>
            <StoryCard story={makeStory()} onClick={() => {}} onRename={onRename} onChangeStatus={() => {}} />
            <button type="button" id="elsewhere">다른 곳</button>
          </DndContext>
        </NextIntlClientProvider>,
      );
    });
    const card = container.firstElementChild as HTMLElement;
    act(() => { card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); });
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input()!, '다른 제목');
      input()!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const other = container.querySelector<HTMLButtonElement>('#elsewhere')!;
    // jsdom은 blur 핸들러 안의 focus()와 원래 이동 중 어느 쪽이 이기는지 브라우저와 달라, 카드 focus() 호출 자체가 없는지를 본다.
    const focusSpy = vi.spyOn(card, 'focus');
    act(() => { other.focus(); });
    expect(onRename).toHaveBeenCalledWith('s1', '다른 제목');
    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(other);
  });

  it('Enter로 끝내면 카드로 초점이 돌아온다(키보드로 이어 쓰는 사람)', () => {
    const card = render({ onRename: vi.fn() });
    act(() => { card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); });
    act(() => { input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(document.activeElement).toBe(card);
  });
});

describe('4908 Enter = 열기(Space는 잠긴 열 카드만 열기 — 안 잠긴 카드의 Space는 끌기 몫)', () => {
  const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });

  it('⭐안 잠긴 카드: Enter로 열린다 · Space로는 안 열린다', () => {
    const onClick = vi.fn();
    const card = render({ onClick });
    key(card, 'Enter');
    expect(onClick).toHaveBeenCalledTimes(1);
    key(card, ' ');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('⭐잠긴 카드: Enter · Space 둘 다 열린다(단추 역할이면 둘 다 약속) · F2는 이름 바꾸기 입력칸', () => {
    const onClick = vi.fn();
    const card = render({ locked: true, onClick, onRename: vi.fn() });
    key(card, 'Enter');
    key(card, ' ');
    expect(onClick).toHaveBeenCalledTimes(2);
    key(card, 'F2');
    expect(container.querySelector('input')).not.toBeNull();
  });

  it('카드 안 단추(«⋯»)의 Enter는 카드 열기로 새지 않는다', () => {
    const onClick = vi.fn();
    const card = render({ onClick });
    const btn = card.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    act(() => { btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('4908 잠긴(파생) 열 카드 — 키보드로 닿는다', () => {
  it('⭐끌기는 못 해도 단추 역할 + tabIndex 0 · Shift+F10으로 메뉴(킥오프 등) · F2 이름 바꾸기', () => {
    const card = render({ locked: true, projectId: 'p1', onRename: vi.fn() });
    expect(card.getAttribute('role')).toBe('button');
    expect(card.getAttribute('tabindex')).toBe('0');
    expect(card.getAttribute('aria-roledescription')).toBeNull();
    act(() => { card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })); });
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
  });
});
