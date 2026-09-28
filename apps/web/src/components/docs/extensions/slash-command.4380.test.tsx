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

// jsdom has no Range/Element getClientRects. `editor.chain().focus()` scrolls the selection into view in a requestAnimationFrame;
// when that frame runs while the editor is still alive, ProseMirror measures the selection and threw «getClientRects is not a
// function» as an unhandled error after the tests passed (vitest rc 1 · 9/10 single-file runs). Same stand-in as the other editor
// tests (code-block-lang-menu-a11y-4364 · doc-editor-heading-anchors …).
const EMPTY_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
for (const proto of [Range.prototype, Element.prototype] as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown }[]) {
  proto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  proto.getBoundingClientRect = () => EMPTY_RECT;
}

type RawItems = Record<keyof SlashMenuStrings['items'], { title: string; description: string }>;
const raw = (koMessages as unknown as { docs: { slashMenu: Omit<SlashMenuStrings, 'items' | 'titles'> & { items: RawItems } } }).docs.slashMenu;
const koStrings: SlashMenuStrings = {
  ...raw,
  items: Object.fromEntries(Object.entries(raw.items).map(([k, v]) => [k, v.description])) as SlashMenuStrings['items'],
  titles: Object.fromEntries(Object.entries(raw.items).map(([k, v]) => [k, v.title])) as SlashMenuStrings['titles'],
  columnsSearchAlias: (raw.items.columns as { searchAlias?: string }).searchAlias ?? '',
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
  it('«/»로 열면 listbox(이름 = 블록 추가) · 분류마다 이름 붙은 group(이름 줄 role=presentation) · 항목 = option', async () => {
    await type('/');
    expect(listbox()?.getAttribute('aria-label')).toBe(koStrings.listLabel);
    const groups = [...listbox()!.querySelectorAll('[role="group"]')].map((g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent);
    expect(groups).toEqual(Object.values(koStrings.categories));
    // 까디르 · PO 07:56Z — 분류 이름 줄은 WAI 묶음 listbox 예처럼 role=presentation(group의 이름으로만 쓰임).
    expect([...listbox()!.querySelectorAll('[role="group"]')].every((g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.getAttribute('role') === 'presentation')).toBe(true);
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

// story #4380(까디르 · PO 07:56Z) — 바깥을 누르거나 편집기에서 초점이 나가면 메뉴가 닫히고 편집기의 aria-controls ·
// aria-activedescendant도 떨어진다. 예전엔(develop부터) 메뉴가 떠 있는 채 남아, 4380 뒤로는 편집기가 보이지 않는 선택지를 계속
// 가리키는 거짓 상태가 됐다.
describe('문서 «/» 메뉴 — 바깥으로 초점이 나가면 닫힘(story #4380)', () => {
  // tiptap의 focus() 명령은 다음 프레임(rAF)에 초점을 준다 — 곧바로 초점을 옮기면 편집기가 아직 초점을 안 가진 채라 blur가 안 난다.
  // 그래서 편집기 요소에 바로 초점을 주고 그게 들어갔는지부터 확인한다(결정적).
  const focusEditorNow = () => act(() => { dom().focus(); });
  it('다른 입력칸(제목 칸 등)으로 초점이 옮겨 가면 메뉴가 닫히고 편집기 속성이 떨어진다', async () => {
    const other = document.createElement('textarea');
    document.body.appendChild(other);
    await type('/');
    expect(listbox()).not.toBeNull();
    focusEditorNow();
    expect(document.activeElement).toBe(dom());
    await act(async () => { other.focus(); await Promise.resolve(); await Promise.resolve(); });
    expect(listbox()).toBeNull();
    expect(dom().hasAttribute('aria-activedescendant')).toBe(false);
    expect(dom().hasAttribute('aria-controls')).toBe(false);
    other.remove();
  });

  it('빈 곳을 눌러 초점이 아무 데도 없어져도(blur) 닫힌다', async () => {
    await type('/');
    expect(listbox()).not.toBeNull();
    focusEditorNow();
    expect(document.activeElement).toBe(dom());
    await act(async () => { dom().blur(); await Promise.resolve(); await Promise.resolve(); });
    expect(listbox()).toBeNull();
    expect(dom().hasAttribute('aria-activedescendant')).toBe(false);
  });
});

// story #4380(까디르 실측 07:43Z) — 넣는 자리: «/»를 친 빈 줄 자리에 블록이 들어간다 = 캐럿이 있던 줄의 바로 앞 블록이 넣은 블록의
// 바로 앞 블록(Enter 길 · 누름 길 둘 다). 명령이 다른 자리(끝 · 처음)로 넣게 되돌아가면 RED.
describe('문서 «/» 메뉴 — 넣는 자리(story #4380)', () => {
  const blocks = () => editor.getJSON().content!.map((n) => ({ type: n.type, text: (n.content ?? []).map((c) => (c as { text?: string }).text ?? '').join('') }));
  const caretOnEmptyLineAfterB = () => act(() => {
    editor.commands.setContent('<p>A</p><p>B</p><p></p><p>C</p>');
    // 셋째 줄(빈 문단) 안: A(3) + B(3) → 빈 문단 여는 자리 6, 그 안 7.
    editor.commands.setTextSelection(7);
    editor.commands.focus();
  });

  it('Enter 길 — 넣은 제목 1의 바로 앞 블록 = «B»(캐럿이 있던 줄 앞) · 뒤 = «C»', async () => {
    caretOnEmptyLineAfterB();
    await type('/');
    await key('Enter');
    const b = blocks();
    const at = b.findIndex((x) => x.type === 'heading');
    expect(at).toBeGreaterThan(0);
    expect(b[at - 1]).toEqual({ type: 'paragraph', text: 'B' });
    expect(b[at + 1]).toEqual({ type: 'paragraph', text: 'C' });
  });

  it('누름 길 — 둘째 항목(제목 2)을 눌러도 같은 자리', async () => {
    caretOnEmptyLineAfterB();
    await type('/');
    await act(async () => { options()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    const b = blocks();
    const at = b.findIndex((x) => x.type === 'heading');
    expect(at).toBeGreaterThan(0);
    expect(b[at - 1]).toEqual({ type: 'paragraph', text: 'B' });
    expect(b[at + 1]).toEqual({ type: 'paragraph', text: 'C' });
  });
});

