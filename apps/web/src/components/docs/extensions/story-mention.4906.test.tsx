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
const pending: Array<{ q: string; resolve: (titles?: string[]) => void }> = [];
/** the picker's search stays pending until released — the network latency that made the late start possible. Every call is recorded, so a test can wait until the search REALLY started (a negative assertion must exercise the race). */
function holdSearch() {
  pending.length = 0;
  const spy = vi.fn((url: string) => new Promise<Response>((resolve) => {
    const q = new URL(`http://x${url}`).searchParams.get('q') ?? '';
    pending.push({
      q,
      resolve: (titles = []) => resolve(new Response(JSON.stringify({
        data: { data: titles.map((title, i) => ({ entity_type: 'story', entity_id: `${q}-${i}`, title })), types: [] },
      }), { status: 200 })),
    });
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}
const searchStarted = (spy: ReturnType<typeof holdSearch>, n = 1) => vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(n));
const releaseAll = () => { while (pending.length) pending.shift()!.resolve(); };
function makeEditor(content = '<p></p>', opts: { codeBlock?: boolean } = {}) {
  editor = new Editor({
    // the real editor's base (doc-editor-extensions.ts: StarterKit; production swaps the code block for its own, which is a code node too) + the story picker
    extensions: [StarterKit.configure(opts.codeBlock ? {} : { codeBlock: false }), StoryMentionExtension.configure({ projectId: 'proj-1', emptyLabel: EMPTY })],
    content,
  });
  editor.commands.focus('end');
  return editor;
}

beforeEach(() => { document.body.innerHTML = ''; pending.length = 0; });
afterEach(() => { editor?.destroy(); editor = null; vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('story picker (#) in the doc editor (story 4906)', () => {
  it('⭐a bare # (or ##) at the START of a line never opens the picker — the heading shortcut «# » · «## » · «### »', async () => {
    const spy = holdSearch();
    const ed = makeEditor();
    for (let i = 0; i < 3; i += 1) {
      ed.commands.insertContent('#');
      await flush(); releaseAll(); await flush();
      expect(popups()).toHaveLength(0);
    }
    expect(spy).not.toHaveBeenCalled();         // refused before any search was even asked for
  });

  it('⭐«#4906» at the start of a line still opens the picker (a story link at the head of a line is real use)', async () => {
    const spy = holdSearch();
    const ed = makeEditor();
    ed.commands.insertContent('#4');
    await searchStarted(spy); releaseAll(); await flush();
    expect(popups()).toHaveLength(1);
    expect(popups()[0]!.textContent).toContain(EMPTY);
  });

  it('⭐«- #4906» in a bullet list item (its paragraph also starts at offset 0) still opens the picker', async () => {
    const spy = holdSearch();
    const ed = makeEditor('<ul><li><p></p></li></ul>');
    ed.commands.focus('end');
    ed.commands.insertContent('#4');
    await searchStarted(spy); releaseAll(); await flush();
    expect(popups()).toHaveLength(1);
  });

  it('⭐a code block is code: a # there opens nothing (at the start of a line or in the middle)', async () => {
    const spy = holdSearch();
    const ed = makeEditor('<pre><code></code></pre>', { codeBlock: true });
    ed.commands.setTextSelection(1);           // INSIDE the code block (focus('end') would land in the paragraph the schema adds after it)
    ed.commands.insertContent('#4906 and echo #x');
    await flush(); releaseAll(); await flush();
    expect(popups()).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a # in the MIDDLE of a line still opens the picker (after text and a space)', async () => {
    const spy = holdSearch();
    const ed = makeEditor();
    ed.commands.insertContent('see #');
    await searchStarted(spy); releaseAll(); await flush();
    const p = popups();
    expect(p).toHaveLength(1);
    expect(p[0]!.textContent).toContain(EMPTY);
  });

  it('⭐a late start — the suggestion ended while the search was still pending — draws NO popup', async () => {
    const spy = holdSearch();
    const ed = makeEditor();
    ed.commands.insertContent('see #');        // suggestion starts, the search is pending
    await searchStarted(spy);
    ed.commands.insertContent(' ');            // a space ends the suggestion (allowSpaces is off) BEFORE the search came back
    await flush();
    releaseAll(); await flush();               // the late `onStart`
    expect(popups()).toHaveLength(0);
  });

  // codex asked for an identity check on the late start. tiptap's plugin keeps ONE shared `props` object that every update overwrites, so a late continuation always hands the renderer the
  // CURRENT suggestion's props — the draw is for the current suggestion, never the old one; what must hold is «never two popups, never an orphan».
  it('⭐an old search resolving after a NEW suggestion became active still leaves exactly one popup — the current one — and none after it ends', async () => {
    const spy = holdSearch();
    const ed = makeEditor();
    ed.commands.insertContent('see #a');       // suggestion one: its search is pending
    await searchStarted(spy, 1);
    ed.commands.insertContent(' and #b');      // suggestion one ended, suggestion two started: a second search is pending
    await searchStarted(spy, 2);
    pending.shift()!.resolve();                 // the OLD search resolves first
    await flush();
    expect(popups().length).toBeLessThanOrEqual(1);
    releaseAll(); await flush();
    expect(popups()).toHaveLength(1);          // exactly the current suggestion's popup
    ed.commands.insertContent(' ');             // it ends
    await flush();
    expect(popups()).toHaveLength(0);
  });

  // codex (last round): «the old search resolving AFTER the new one overwrites props.items and the popup is redrawn with the OLD results». `props.items = await items(...)` evaluates its
  // target (the props object of THAT update) before the await, so the old continuation writes onto the old object and the shared current props keep the NEW results. Measured here with two searches
  // that return different stories, resolved in both orders.
  for (const order of ['new-then-old', 'old-then-new'] as const) {
    it(`⭐two searches in flight (${order}): the popup shows the CURRENT query's stories, never the old query's`, async () => {
      const spy = holdSearch();
      const ed = makeEditor();
      ed.commands.insertContent('see #a');
      await searchStarted(spy, 1);
      ed.commands.insertContent(' and #b');
      await searchStarted(spy, 2);
      const [oldS, newS] = [pending.find((p) => p.q === 'a')!, pending.find((p) => p.q === 'b')!];
      expect(oldS).toBeTruthy(); expect(newS).toBeTruthy();
      if (order === 'new-then-old') { newS.resolve(['NEW story']); await flush(); oldS.resolve(['OLD story']); } else { oldS.resolve(['OLD story']); await flush(); newS.resolve(['NEW story']); }
      await flush();
      expect(popups()).toHaveLength(1);
      expect(popups()[0]!.textContent).toContain('NEW story');
      expect(popups()[0]!.textContent).not.toContain('OLD story');
    });
  }

  it('when the editor is destroyed (save → the reading screen) a popup that is still up is taken down', async () => {
    const spy = holdSearch();
    const ed = makeEditor();
    ed.commands.insertContent('see #');
    await searchStarted(spy); releaseAll(); await flush();
    expect(popups()).toHaveLength(1);
    ed.destroy(); editor = null;
    await flush();
    expect(popups()).toHaveLength(0);
  });

  it('a late start after the editor is destroyed draws nothing either', async () => {
    const spy = holdSearch();
    const ed = makeEditor();
    ed.commands.insertContent('see #');
    await searchStarted(spy);
    ed.destroy(); editor = null;
    releaseAll(); await flush();
    expect(popups()).toHaveLength(0);
  });
});
