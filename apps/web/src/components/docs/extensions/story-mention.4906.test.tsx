// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { StoryMentionExtension } from './story-mention';

// story 4906 — «## 제목» in the doc editor opened the story picker («일치하는 스토리가 없어요») and the popup stayed after Enter, after a click elsewhere and after saving.
// Two causes, both pinned here with a REAL editor + the real extension (the picker's search is a stubbed fetch we hold open on purpose):
//  1. a bare `#` at the start of a line is the heading shortcut → it does not open the picker; «#4906» at the start of a line or of a bullet («- #4906 …») still does, and a `#` in the middle of a line opens it at once.
//  2. tiptap calls onStart only after `await items()`; if the suggestion ended meanwhile (the person typed on) that late start drew a popup nobody closed.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY = '일치하는 스토리가 없어요';
const popups = () => [...document.body.children].filter((d) => /z-index:\s*9999/.test(d.getAttribute('style') ?? '')) as HTMLElement[];
// enough real time for tiptap's async update + the stubbed fetch's body parsing to settle even on a loaded CI machine (a negative assertion must not pass just because nothing ran yet)
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 8)); };

let editor: Editor | null = null;
let release: (() => void) | null = null;
/** the picker's search stays pending until `release()` — the network latency that made the late start possible */
function holdSearch() {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
    release = () => resolve(new Response(JSON.stringify({ data: { data: [], types: [] } }), { status: 200 }));
  })));
}
function makeEditor(content = '<p></p>') {
  editor = new Editor({
    // the real editor's base (doc-editor-extensions.ts: StarterKit without the code block) + the story picker
    extensions: [StarterKit.configure({ codeBlock: false }), StoryMentionExtension.configure({ projectId: 'proj-1', emptyLabel: EMPTY })],
    content,
  });
  editor.commands.focus('end');
  return editor;
}

beforeEach(() => { document.body.innerHTML = ''; release = null; });
afterEach(() => { editor?.destroy(); editor = null; vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('story picker (#) in the doc editor (story 4906)', () => {
  it('⭐a bare # (or ##) at the START of a line never opens the picker — the heading shortcut «# » · «## » · «### »', async () => {
    holdSearch();
    const ed = makeEditor();
    ed.commands.insertContent('#');
    await flush(); release?.(); await flush();
    expect(popups()).toHaveLength(0);
    ed.commands.insertContent('#');
    await flush(); release?.(); await flush();
    expect(popups()).toHaveLength(0);
    ed.commands.insertContent('#');           // «###»
    await flush(); release?.(); await flush();
    expect(popups()).toHaveLength(0);
  });

  it('⭐«#4906» at the start of a line still opens the picker (a story link at the head of a line is real use)', async () => {
    holdSearch();
    const ed = makeEditor();
    ed.commands.insertContent('#4');
    await flush(); release?.(); await flush();
    expect(popups()).toHaveLength(1);
    expect(popups()[0]!.textContent).toContain(EMPTY);
  });

  it('⭐«- #4906» in a bullet list item (its paragraph also starts at offset 0) still opens the picker', async () => {
    holdSearch();
    const ed = makeEditor('<ul><li><p></p></li></ul>');
    ed.commands.focus('end');
    ed.commands.insertContent('#4');
    await flush(); release?.(); await flush();
    expect(popups()).toHaveLength(1);
  });

  it('a # in the MIDDLE of a line still opens the picker (after text and a space)', async () => {
    holdSearch();
    const ed = makeEditor();
    ed.commands.insertContent('see #');
    await flush(); release?.(); await flush();
    const p = popups();
    expect(p).toHaveLength(1);
    expect(p[0]!.textContent).toContain(EMPTY);
  });

  it('⭐a late start — the suggestion ended while the search was still pending — draws NO popup', async () => {
    holdSearch();
    const ed = makeEditor();
    ed.commands.insertContent('see #');       // suggestion starts, the search is pending
    await flush();
    ed.commands.insertContent(' ');            // a space ends the suggestion (allowSpaces is off) BEFORE the search came back
    await flush();
    release?.(); await flush();                // the late `onStart`
    expect(popups()).toHaveLength(0);
  });

  it('when the editor is destroyed (save → the reading screen) a popup that is still up is taken down', async () => {
    holdSearch();
    const ed = makeEditor();
    ed.commands.insertContent('see #');
    await flush(); release?.(); await flush();
    expect(popups()).toHaveLength(1);
    ed.destroy(); editor = null;
    await flush();
    expect(popups()).toHaveLength(0);
  });

  it('a late start after the editor is destroyed draws nothing either', async () => {
    holdSearch();
    const ed = makeEditor();
    ed.commands.insertContent('see #');
    await flush();
    ed.destroy(); editor = null;
    release?.(); await flush();
    expect(popups()).toHaveLength(0);
  });
});
