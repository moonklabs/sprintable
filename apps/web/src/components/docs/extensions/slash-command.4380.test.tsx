// @vitest-environment jsdom
// story #4380 — 문서 «/» 메뉴: 화면 읽기가 지금 켜진 항목을 안다. 메뉴 = listbox(이름) · 분류 = 이름 붙은 group · 항목 = option(켜진 것
// aria-selected) · 초점은 편집기(tiptap role="textbox")에 그대로 두고 편집기 요소에 aria-controls · aria-activedescendant — 닫히면 뗀다.
// 예전엔 단추 목록뿐이라 ↑↓로 옮긴 «켜짐»이 모양(bg-brand)으로만 보였다. 실 tiptap 편집기에 «/»를 쳐서 연다(메뉴 목킹 0).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createSlashCommandExtension, type SlashMenuStrings } from './slash-command';
import koMessages from '../../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RawItems = Record<keyof SlashMenuStrings['items'], { title: string; description: string }>;
const raw = (koMessages as unknown as { docs: { slashMenu: Omit<SlashMenuStrings, 'items' | 'titles'> & { items: RawItems } } }).docs.slashMenu;
const koStrings: SlashMenuStrings = {
  ...raw,
  items: Object.fromEntries(Object.entries(raw.items).map(([k, v]) => [k, v.description])) as SlashMenuStrings['items'],
  titles: Object.fromEntries(Object.entries(raw.items).map(([k, v]) => [k, v.title])) as SlashMenuStrings['titles'],
};

let host: HTMLDivElement;
let editor: Editor;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new Editor({ element: host, extensions: [StarterKit, createSlashCommandExtension(koStrings)], content: '<p></p>' });
});

afterEach(() => {
  act(() => { editor.destroy(); });
  host.remove();
  document.querySelectorAll('[role="listbox"]').forEach((el) => el.closest('div[style]')?.remove());
});

const dom = () => editor.view.dom as HTMLElement;
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const active = () => document.getElementById(dom().getAttribute('aria-activedescendant') ?? '');
// suggestion 플러그인의 view update는 async(items를 기다린 뒤 onStart/onUpdate) — 마이크로태스크를 비운다.
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const type = (text: string) => act(async () => { editor.chain().focus().insertContent(text).run(); await flush(); });
const key = (k: string) => act(async () => { dom().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); await flush(); });

describe('문서 «/» 메뉴 — 목록상자 · 켜진 항목 알림(story #4380)', () => {
  it('«/»로 열면 listbox(이름 = 블록 넣기) · 분류마다 이름 붙은 group · 항목 = option', async () => {
    await type('/');
    expect(listbox()?.getAttribute('aria-label')).toBe(koStrings.listLabel);
    const groups = [...listbox()!.querySelectorAll('[role="group"]')].map((g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent);
    expect(groups).toEqual(Object.values(koStrings.categories));
    expect(options()).toHaveLength(Object.keys(koStrings.items).length);
    expect(options().every((o) => listbox()!.contains(o) && o.tagName === 'DIV')).toBe(true);
  });

  it('편집기(role textbox)가 목록 · 첫 항목을 가리킨다 · ↓ 하면 둘째로(aria-selected도 하나만 따라감)', async () => {
    await type('/');
    expect(dom().getAttribute('role')).toBe('textbox');
    expect(dom().getAttribute('aria-controls')).toBe(listbox()!.id);
    expect(active()).toBe(options()[0]);
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toEqual([options()[0]]);
    await key('ArrowDown');
    expect(active()).toBe(options()[1]);
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toEqual([options()[1]]);
  });

  it('거르면 켜진 항목도 거른 목록의 첫 항목 · 맞는 것이 없으면(메뉴 닫힘) 편집기 속성을 뗀다', async () => {
    await type('/');
    await type('표');
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining(koStrings.titles.table)]);
    expect(active()).toBe(options()[0]);
    await type('zzzz');
    expect(options()).toHaveLength(0);
    expect(dom().hasAttribute('aria-activedescendant')).toBe(false);
    expect(dom().hasAttribute('aria-controls')).toBe(false);
  });

  it('Escape로 닫으면 편집기 속성을 뗀다(가리키는 id가 사라진 채 남지 않음)', async () => {
    await type('/');
    expect(dom().hasAttribute('aria-activedescendant')).toBe(true);
    await key('Escape');
    expect(listbox()).toBeNull();
    expect(dom().hasAttribute('aria-activedescendant')).toBe(false);
    expect(dom().hasAttribute('aria-controls')).toBe(false);
  });

  it('Enter로 고르면 그 블록이 들어가고 편집기 속성을 뗀다', async () => {
    await type('/');
    await key('Enter');  // 첫 항목 = 제목 1
    expect(editor.getHTML()).toContain('<h1');
    expect(dom().hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('항목 · 목록 빈 곳을 눌러도 편집기 초점을 뺏지 않는다(mousedown 기본 동작 막음)', async () => {
    await type('/');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    options()[2].dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    // 목록 안 빈 곳(분류 이름)도 — 초점 받을 수 없는 곳을 누르면 브라우저가 편집기 초점을 푼다.
    const label = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    listbox()!.querySelector('[role="group"] > p')!.dispatchEvent(label);
    expect(label.defaultPrevented).toBe(true);
    expect(listbox()!.hasAttribute('tabindex')).toBe(false);  // 탭 순서에 안 듦(초점은 편집기)
  });
});
