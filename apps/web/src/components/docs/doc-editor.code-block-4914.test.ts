// @vitest-environment jsdom
/**
 * story 4914 — 문서 편집기에서 코드 블록을 «새로 만들 수 있어야» 한다.
 * 예전: 코드 블록이 `Node.create`로 새로 만든 노드라 `toggleCodeBlock` 명령 · ``` 입력 규칙 · 단축키가 없었다 — «/코드 블록»(슬래시) · 도구줄 단추가
 * `toggleCodeBlock is not a function`으로 던지고 ```로도 안 만들어졌다(dev 실측 11-12 · 2026-04-18 218ed0cea부터).
 * 판정은 실제 편집기(편집기와 같은 확장 목록)에서 세 길로 코드 블록이 생기는가 — 슬래시 항목의 command · 도구줄 단추와 같은 체인 · ``` 입력 규칙 · 단축키.
 * 4339 왕복(HTML 문서의 코드 부분을 잃지 않음 · 언어 속성)은 doc-editor-roundtrip.test.ts · doc-markdown-save-parts.test.tsx가 그대로 지킨다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/core';
import { makeDocEditor } from './doc-editor-roundtrip.fixture';
import { buildSlashMenuCategories } from './extensions/slash-command';
import { CodeBlockWithCopy } from './extensions/code-block-copy';
import { createWikiLinkSuggestion } from './extensions/wiki-link';

let editor: Editor | null = null;
afterEach(() => { editor?.destroy(); editor = null; });

const SLASH_STRINGS = new Proxy({}, { get: () => 'x' }) as never;
/** 편집기는 맨 끝에 빈 문단을 자동으로 두므로(끝 노드) «첫 블록»과 «코드 블록 개수»로 판정한다. */
const first = (e: Editor) => e.state.doc.firstChild!.type.name;
const codeBlockCount = (e: Editor) => { let n = 0; e.state.doc.descendants((node) => { if (node.type.name === 'codeBlock') n += 1; }); return n; };

/** 사람이 «```» 를 치고 스페이스를 누른 것과 같게: 글자를 넣고 handleTextInput(입력 규칙이 듣는 길)에 스페이스를 건넨다. */
function typeFenceThenSpace(e: Editor, fence: string): boolean {
  e.commands.setContent('<p></p>');
  e.commands.focus('end');
  e.commands.insertContent(fence);
  const { from, to } = e.state.selection;
  return !!e.view.someProp('handleTextInput', (f) => f(e.view, from, to, ' ', () => e.state.tr));
}

describe('코드 블록 확장 — 이어받음(extend)으로 명령 · 규칙 · 단축키를 갖는다', () => {
  it('⭐확장 이름은 codeBlock 그대로 · toggleCodeBlock / setCodeBlock 명령이 있다(예전: 없어서 «is not a function»)', () => {
    expect(CodeBlockWithCopy.name).toBe('codeBlock');
    editor = makeDocEditor('<p>hello</p>');
    expect(editor.schema.nodes['codeBlock']).toBeDefined();
    expect(typeof editor.commands.toggleCodeBlock).toBe('function');
    expect(typeof editor.commands.setCodeBlock).toBe('function');
  });

  it('⭐도구줄 단추 길 — 단추가 부르는 체인(`chain().focus().toggleCodeBlock().run()`)이 문단을 코드 블록으로 바꾸고, 한 번 더 부르면 문단으로 돌아온다', () => {
    editor = makeDocEditor('<p>hello</p>');
    editor.commands.focus('end');
    expect(editor.chain().focus().toggleCodeBlock().run()).toBe(true);
    expect(first(editor)).toBe('codeBlock');
    expect(editor.isActive('codeBlock')).toBe(true); // 도구줄 단추의 «켜짐» 표시가 읽는 값
    expect(editor.state.doc.textContent).toBe('hello');
    expect(editor.chain().focus().toggleCodeBlock().run()).toBe(true);
    expect(first(editor)).toBe('paragraph');
    expect(codeBlockCount(editor)).toBe(0);
  });

  it('⭐슬래시 «코드 블록» 길 — 메뉴 항목의 command가 «/code» 글자를 지우고 코드 블록을 만든다(던지지 않음)', () => {
    editor = makeDocEditor('<p>/code</p>');
    const item = buildSlashMenuCategories(SLASH_STRINGS).flatMap((c) => c.items).find((i) => i.id === 'codeBlock');
    expect(item).toBeDefined();
    // 문단 «/code» 전체(위치 1~6)가 슬래시 제안의 범위
    expect(() => item!.command(editor!, { from: 1, to: 6 })).not.toThrow();
    expect(first(editor)).toBe('codeBlock');
    expect(editor.state.doc.textContent).toBe('');
  });

  it('⭐``` + 스페이스 입력 규칙 — 코드 블록이 되고(언어 없음), «```ts » 는 언어가 ts다', () => {
    editor = makeDocEditor('<p></p>');
    expect(typeFenceThenSpace(editor, '```')).toBe(true);
    expect(first(editor)).toBe('codeBlock');
    expect(editor.state.doc.firstChild!.attrs['language']).toBeNull();
    expect(typeFenceThenSpace(editor, '```ts')).toBe(true);
    expect(editor.state.doc.firstChild!.type.name).toBe('codeBlock');
    expect(editor.state.doc.firstChild!.attrs['language']).toBe('ts');
  });

  it('⭐단축키 Mod-Alt-c(확장이 준다) — 문단 ↔ 코드 블록 토글', () => {
    editor = makeDocEditor('<p>x</p>');
    editor.commands.focus('end');
    const press = () => editor!.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
    press();
    expect(first(editor)).toBe('codeBlock');
    press();
    expect(first(editor)).toBe('paragraph');
    expect(codeBlockCount(editor)).toBe(0);
  });

  it('⭐언어를 줘서 만든 코드 블록은 저장 HTML에 <pre data-language> 와 <code class="language-…"> 양쪽이 실린다(FIX-3b · Turndown이 펜스 언어를 code 클래스에서 읽는다)', () => {
    editor = makeDocEditor('<p>print(1)</p>');
    editor.commands.focus('end');
    editor.chain().focus().toggleCodeBlock({ language: 'python' }).run();
    const root = document.createElement('div');
    root.innerHTML = editor.getHTML();
    const pre = root.querySelector('pre')!;
    expect(pre.getAttribute('data-language')).toBe('python');
    expect(pre.querySelector('code')!.className).toBe('language-python');
    expect(pre.textContent).toBe('print(1)');
  });

  it('4339가 지키던 것 — 불러온 HTML의 코드 블록(언어 포함)은 다시 저장해도 그대로(왕복)', () => {
    editor = makeDocEditor('<pre data-language="python"><code class="language-python">print(1)\nprint(2)</code></pre>');
    const root = document.createElement('div');
    root.innerHTML = editor.getHTML();
    expect(root.querySelector('pre')!.getAttribute('data-language')).toBe('python');
    expect(root.querySelector('code')!.className).toBe('language-python');
    expect(root.querySelector('code')!.textContent).toBe('print(1)\nprint(2)');
  });
});

describe('코드 블록 안에서는 «/» · «[[» 제안이 열리지 않는다 · 붙여넣기 플러그인은 싣지 않는다(코덱스 1차)', () => {
  // 슬래시 제안 플러그인의 지금 상태(prosemirror는 같은 이름의 키를 새로 만들면 `이름$1`로 가르므로, 편집기에 실린 플러그인을 이름으로 찾아 읽는다)
  const slashActive = (e: Editor): boolean | undefined => {
    const plugin = e.state.plugins.find((pl) => String((pl as unknown as { key: string }).key).startsWith('slashCommandSuggestion'));
    return (plugin?.getState(e.state) as { active?: boolean } | undefined)?.active;
  };

  it('⭐코드 블록 안에서 «/co»를 쳐도 슬래시 메뉴가 안 열린다 — 문단에서는 열린다(대조)', () => {
    editor = makeDocEditor('<p></p>');
    editor.commands.focus('end');
    editor.commands.insertContent('/co');
    expect(slashActive(editor), '문단(대조)').toBe(true);
    editor.commands.setContent('<pre><code></code></pre>');
    editor.commands.setTextSelection(1); // 코드 블록 안(맨 앞)
    expect(editor.isActive('codeBlock')).toBe(true);
    editor.commands.insertContent('/co');
    expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock');
    expect(slashActive(editor), '코드 블록').toBeFalsy();
  });

  it('⭐코드 블록 안의 «[[»는 위키 링크 제안의 allow가 거절한다 — 문단에서는 허용(대조)', () => {
    const allow = createWikiLinkSuggestion('p1', 'not found').allow!;
    editor = makeDocEditor('<p>a</p>');
    editor.commands.focus('end');
    const para = { state: editor.state, range: { from: editor.state.selection.from, to: editor.state.selection.from }, editor, isActive: false };
    expect(allow(para)).toBe(true);
    editor.commands.setContent('<pre><code>a</code></pre>');
    editor.commands.setTextSelection(2); // 코드 블록 안(글자 «a» 뒤)
    expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock');
    const code = { state: editor.state, range: { from: 1, to: 2 }, editor, isActive: false };
    expect(allow(code)).toBe(false);
  });

  it('⭐확장이 거저 주는 «VS Code 붙여넣기» 플러그인은 싣지 않는다(검사 없는 JSON.parse가 붙여넣기를 던지게 하지 않음)', () => {
    editor = makeDocEditor('<p>x</p>');
    const keys = editor.state.plugins.map((pl) => String((pl as unknown as { key: string }).key));
    expect(keys.some((k) => k.startsWith('codeBlockVSCodeHandler'))).toBe(false);
  });
});
