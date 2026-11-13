// @vitest-environment jsdom
//
// 4908 넷째 조각 — 키보드 끌기를 «실제 DndContext»로: 보드 시험 파일은 DndContext를 모킹하므로(끌기 콜백을 손에 쥐려고) 센서 · 낭독 동작은 여기서 같은 설정(board-dnd.ts)으로 잰다.
// Space로 집고 · Esc로 취소 · Space/Enter로 놓는다. Enter 단독은 «열기»(집지 않는다). 끄는 중의 Enter는 끌기를 끝낼 뿐 열기가 아니다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import { DndContext, KeyboardSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import koMessages from '../../../messages/ko.json';
import { KEYBOARD_SENSOR_OPTIONS, buildDndAccessibility, useKeyboardDropRefocus } from './board-dnd';
import { StoryCard } from './story-card';
import type { KanbanStory } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const story = (id: string, title: string) => ({ id, title, status: 'backlog', priority: 'medium', story_points: null, assignee_id: null, assignee_ids: [], epic_id: null }) as unknown as KanbanStory;
const stories = [story('s1', '카드하나'), story('s2', '카드둘')];

function Harness({ onClick, onDragEnd }: { onClick: (id: string) => void; onDragEnd: (e: unknown) => void }) {
  const t = useTranslations('board');
  const sensors = useSensors(useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS));
  const title = (id: string | number) => stories.find((s) => s.id === String(id))?.title ?? '';
  const accessibility = buildDndAccessibility(t as never, title, title);
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} accessibility={accessibility} onDragEnd={onDragEnd}>
      <SortableContext items={stories.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div data-board-column="backlog">
          {stories.map((s) => <StoryCard key={s.id} story={s} onClick={() => onClick(s.id)} onChangeStatus={() => {}} />)}
        </div>
      </SortableContext>
    </DndContext>
  );
}

let container: HTMLDivElement;
let root: Root;
const onClick = vi.fn();
const onDragEnd = vi.fn();
beforeEach(() => {
  onClick.mockReset(); onDragEnd.mockReset();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  act(() => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><Harness onClick={onClick} onDragEnd={onDragEnd} /></NextIntlClientProvider>); });
});
afterEach(() => { act(() => { root.unmount(); }); container.remove(); });

const card = (title: string) => container.querySelector<HTMLElement>(`[title="${title}"]`)!;
const key = (el: Element | Document, code: string, k = code) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { code, key: k, bubbles: true, cancelable: true })); await Promise.resolve(); });
// dnd-kit은 시작 뒤 한 틱 늦게 문서 키 듣기를 건다.
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const live = () => [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent).join(' ');

describe('키보드 끌기(실제 DndContext)', () => {
  it('⭐Space로 집으면 끌기가 시작되고(aria-pressed) 한국어 낭독이 나온다 · 안내문도 한국어', async () => {
    await key(card('카드하나'), 'Space', ' ');
    await tick();
    expect(card('카드하나').getAttribute('aria-pressed')).toBe('true');
    expect(live()).toContain('카드하나 카드를 집었어요');
    expect(document.body.textContent).toContain(koMessages.board.dndInstructions);
  });

  it('⭐끄는 중 Esc = 취소(낭독 «취소했어요») · 놓기 콜백은 안 불리고 끌기 표시가 사라진다', async () => {
    await key(card('카드하나'), 'Space', ' ');
    await tick();
    await key(document, 'Escape', 'Escape');
    await tick();
    expect(card('카드하나').getAttribute('aria-pressed')).toBeNull();
    expect(live()).toContain('옮기기를 취소했어요');
  });

  it('⭐끄는 중 Space = 놓기(onDragEnd) — 카드를 열지 않는다', async () => {
    await key(card('카드하나'), 'Space', ' ');
    await tick();
    await key(document, 'Space', ' ');
    await tick();
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(card('카드하나').getAttribute('aria-pressed')).toBeNull();
  });

  it('⭐끄는 중 Enter = 놓기, 열기 아님 · 안 끄는 때의 Enter = 열기', async () => {
    await key(card('카드둘'), 'Enter', 'Enter');
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenLastCalledWith('s2');
    onClick.mockReset();
    await key(card('카드하나'), 'Space', ' ');
    await tick();
    await key(card('카드하나'), 'Enter', 'Enter'); // 끄는 중 카드에 초점이 있는 채로 누른 Enter
    await tick();
    expect(onClick).not.toHaveBeenCalled();
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('⭐센서 설정 자체: 집기는 Space뿐 · 놓기는 Space/Enter · 취소는 Esc(카드가 Enter를 먼저 «열기»로 가로채도 설정이 어긋나 있으면 안 된다)', () => {
    expect(KEYBOARD_SENSOR_OPTIONS.keyboardCodes).toEqual({ start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] });
  });

  it('⭐Enter 단독은 집지 않는다(집기는 Space만)', async () => {
    await key(card('카드하나'), 'Enter', 'Enter');
    await tick();
    expect(card('카드하나').getAttribute('aria-pressed')).toBeNull();
  });
});

describe('카드 안쪽 키는 끌기로 넘기지 않는다(codex 4조각)', () => {
  it('⭐메뉴(포털) 항목을 Space로 눌러도 끌기가 시작되지 않는다 — 항목의 Space가 React 포털을 타고 카드까지 올라와도', async () => {
    const btn = card('카드하나').querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const item = document.body.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(item).not.toBeNull();
    await key(item, 'Space', ' ');
    await tick();
    expect(card('카드하나').getAttribute('aria-pressed')).toBeNull();
    expect(live()).not.toContain('집었어요');
  });
});

describe('useKeyboardDropRefocus — 키보드로 놓은 카드의 초점 되돌리기', () => {
  let mark: (id: string) => void = () => {};
  function Probe({ list }: { list: string[] }) {
    const m = useKeyboardDropRefocus(list);
    useEffect(() => { mark = m; }, [m]);
    return <div>{list.map((id) => <button key={id} data-story-id={id} id={id}>{id}</button>)}</div>;
  }
  const rerender = (list: string[]) => act(() => { root.render(<Probe list={list} />); });
  beforeEach(() => { act(() => { root.render(<Probe list={['a', 'b']} />); }); (document.activeElement as HTMLElement | null)?.blur?.(); });

  it('⭐놓은 카드가 목록이 바뀐 뒤(새 열에서 다시 만들어진 뒤)에도 초점이 아무 데도 없으면 그 카드로 초점이 간다', () => {
    mark('b');
    expect(document.activeElement).toBe(document.body);
    rerender(['b', 'a']); // 목록이 바뀜
    expect(document.activeElement?.id).toBe('b');
  });

  it('⭐그 사이 사람이 다른 곳에 초점을 두었으면 가로채지 않는다', () => {
    mark('b');
    (document.getElementById('a') as HTMLElement).focus();
    rerender(['b', 'a']);
    expect(document.activeElement?.id).toBe('a');
  });

  it('⭐5초가 지나면 잊는다', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-13T00:00:00Z'));
      mark('b');
      vi.setSystemTime(new Date('2026-11-13T00:00:06Z'));
      rerender(['b', 'a']);
      expect(document.activeElement).toBe(document.body);
    } finally { vi.useRealTimers(); }
  });
});
