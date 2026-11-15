// @vitest-environment jsdom
//
// story 4945 (맥 앱 데스크톱 손길 · 일감) — 격리 맥 앱에서 진짜 마우스 · 키로 잰 불편 중 웹 쪽 넷. 되돌리면 RED:
// ② 이름 바꾸기 입력창 우클릭은 글자 칸의 것(카드 메뉴가 가로채지 않는다) · ③ 목록 보기 ↑↓ = 상태 묶음을 가로지른 이웃 카드 · ④ 목록 행 우클릭 메뉴에 «스토리 수정» · «스토리 삭제»(보드 카드와 같은 두 항목).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DndContext } from '@dnd-kit/core';
import koMessages from '../../../messages/ko.json';
import { StoryCard } from './story-card';
import { KanbanListView } from './kanban-list-view';
import { moveCardFocus } from './card-nav';
import type { KanbanStory } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const board = koMessages.board as unknown as Record<string, string>;
function makeStory(o: Partial<KanbanStory> = {}): KanbanStory {
  return {
    id: 's1', story_number: 1, title: 'Story', status: 'backlog', priority: 'medium', story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
    description: null, acceptance_criteria: null, attachments: null, position: null, success_hypothesis: null, metric_definition: null, measure_after: null,
    outcome_status: 'n_a', outcome_result: null, ...o,
  };
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.restoreAllMocks(); });
const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DndContext>{node}</DndContext></NextIntlClientProvider>
);
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const rightClick = (el: Element) => { const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }); el.dispatchEvent(ev); return ev; };
const menuLabels = () => [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((e) => (e.textContent ?? '').trim());

describe('② 이름 바꾸기 입력창 우클릭 — 글자 칸의 것', () => {
  it('⭐입력창 우클릭은 카드 메뉴를 열지 않고 기본 동작(글자 메뉴)도 막지 않는다 · 카드 몸통 우클릭은 그대로 카드 메뉴', async () => {
    await act(async () => { root.render(wrap(<StoryCard story={makeStory({ title: '카드 제목' })} onClick={() => {}} onRename={() => {}} onEdit={() => {}} onChangeStatus={() => {}} />)); });
    const card = container.querySelector<HTMLElement>('[data-story-card]')!;
    await act(async () => { card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true })); });
    const input = container.querySelector<HTMLInputElement>('input')!;
    expect(input).not.toBeNull();
    let ev!: MouseEvent;
    await act(async () => { ev = rightClick(input); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
    // 대조: 입력창이 아닌 카드 몸통 우클릭은 카드 메뉴(+ preventDefault) — 이 손길이 카드 메뉴를 없애지 않았다
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    let ev2!: MouseEvent;
    await act(async () => { ev2 = rightClick(card); });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(ev2.defaultPrevented).toBe(true);
  });
});

describe('③ 목록 보기 ↑↓ — 상태 묶음을 가로질러', () => {
  it('⭐card-nav: [data-board-list] 안에서 ↓↑ = 화면 순서의 이웃(묶음 경계를 넘음) · 처음/끝 · ←→ = 갈 곳 없음', () => {
    document.body.innerHTML = `<div data-board-list>
      <div><div data-story-card tabindex="0" id="a1"></div><div data-story-card tabindex="0" id="a2"></div></div>
      <div><div data-story-card tabindex="0" id="b1"></div></div></div>`;
    const $ = (id: string) => document.getElementById(id) as HTMLElement;
    expect(moveCardFocus($('a2'), 'ArrowDown')).toBe(true);
    expect(document.activeElement).toBe($('b1')); // 묶음 경계를 넘는다
    expect(moveCardFocus($('b1'), 'ArrowUp')).toBe(true);
    expect(document.activeElement).toBe($('a2'));
    expect(moveCardFocus($('a1'), 'ArrowUp')).toBe(false);
    expect(moveCardFocus($('b1'), 'ArrowDown')).toBe(false);
    expect(moveCardFocus($('a1'), 'ArrowRight')).toBe(false);
    expect(moveCardFocus($('a1'), 'ArrowLeft')).toBe(false);
  });
  it('⭐실제 목록 보기: 한 상태의 마지막 카드에서 ↓ = 다음 상태의 첫 카드', async () => {
    const stories = [makeStory({ id: 'b1', title: '백로그 하나', status: 'backlog' }), makeStory({ id: 'p1', title: '진행 하나', status: 'in-progress' })];
    await act(async () => { root.render(wrap(<KanbanListView stories={stories} epicMap={{}} memberMap={{}} onStoryClick={() => {}} onChangeStatus={async () => {}} />)); });
    const cards = [...container.querySelectorAll<HTMLElement>('[data-story-card]')];
    expect(cards).toHaveLength(2);
    cards[0]!.focus();
    await act(async () => { cards[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(cards[1]);
    await act(async () => { cards[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(cards[0]);
  });
});

describe('④ 목록 행 우클릭 메뉴 — 수정 · 삭제', () => {
  it('⭐넘겨 준 것만큼: 수정 · 삭제 둘 다 있으면 보드 카드와 같은 두 항목이 뜬다 · 수정은 그 스토리를 연다', async () => {
    const onEdit = vi.fn(); const onDelete = vi.fn();
    await act(async () => { root.render(wrap(<KanbanListView stories={[makeStory({ id: 'e1', title: '메뉴 시험' })]} epicMap={{}} memberMap={{}} onStoryClick={() => {}} onChangeStatus={async () => {}} onEditStory={onEdit} onDeleteStory={onDelete} />)); });
    await act(async () => { rightClick(container.querySelector('[data-story-card]')!); });
    const labels = menuLabels();
    expect(labels).toContain(board.editStory);
    expect(labels).toContain(board.deleteStory);
    const edit = [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].find((e) => (e.textContent ?? '').trim() === board.editStory) as HTMLElement;
    await act(async () => { edit.click(); });
    expect(onEdit).toHaveBeenCalledWith('e1');
  });
  it('삭제를 안 넘기면(사람이 아닌 계정) 삭제 항목은 없다 — 보드와 같은 규칙', async () => {
    await act(async () => { root.render(wrap(<KanbanListView stories={[makeStory({ id: 'e1' })]} epicMap={{}} memberMap={{}} onStoryClick={() => {}} onChangeStatus={async () => {}} onEditStory={() => {}} />)); });
    await act(async () => { rightClick(container.querySelector('[data-story-card]')!); });
    expect(menuLabels()).toContain(board.editStory);
    expect(menuLabels()).not.toContain(board.deleteStory);
  });
});

describe('연결 — 진짜 KanbanBoard가 목록 보기에 수정 · 삭제 콜백을 넘긴다(가드: 글 그대로)', () => {
  it('⭐목록 보기 자리에 onEditStory={handleEditStory} + 사람만 onDeleteStory(에이전트는 undefined)', () => {
    const src = readFileSync(join(__dirname, 'kanban-board.tsx'), 'utf8');
    const at = src.indexOf('<KanbanListView');
    expect(at).toBeGreaterThan(0);
    const tag = src.slice(at, src.indexOf('/>', at));
    expect(tag).toContain('onEditStory={handleEditStory}');
    expect(tag).toContain('onDeleteStory={isHuman ? handleDeleteStory : undefined}');
  });
});
