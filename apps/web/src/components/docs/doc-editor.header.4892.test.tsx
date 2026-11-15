// @vitest-environment jsdom
//
// story 4892 (UI-9 상세 열, 편집기 머리) — the editor's card and its one-line header wear the ds parts: ds line/background, the tree opener is a ds
// IconButton, the preview/markdown switch is two ds Buttons (aria-pressed), «저장» is the ds primary Button. Behaviour is unchanged: the opener
// calls onOpenTree, the switch flips the mode, save calls onSave only when dirty.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('@tiptap/react/menus', () => ({ BubbleMenu: () => null }));

const { DocEditor } = await import('./doc-editor');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LABELS = {
  contentFormat: 'Format', markdown: 'Markdown', preview: 'Preview', save: 'Save', toolbar: 'Toolbar',
  placeholder: 'Write something…', h1: 'H1', h2: 'H2', bold: 'Bold', italic: 'Italic', bullet: 'Bullet',
  quote: 'Quote', code: 'Code', link: 'Link', autosave: 'Autosave', undo: 'Undo', redo: 'Redo',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount(over: Partial<React.ComponentProps<typeof DocEditor>> = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocEditor value="본문" contentFormat="html" onChange={() => {}} labels={LABELS} title="제목" onTitleChange={() => {}} {...over} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}
const header = () => container.querySelector('header')!;
const btn = (text: string) => [...header().querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe('DocEditor header — ds parts (4892)', () => {
  it('⭐the card and the header use the ds line and background, not the old border/card tokens', async () => {
    await mount();
    const card = container.firstElementChild as HTMLElement;
    expect(card.className.split(/\s+/)).toContain('border-ds-line');
    expect(card.className.split(/\s+/)).toContain('bg-ds-background');
    expect(card.className).not.toContain('bg-card');
    const hcls = header().className.split(/\s+/);
    expect(hcls).toContain('border-ds-line');
    expect(hcls).toContain('bg-ds-background');
    expect(hcls).not.toContain('bg-card');
  });

  it('⭐the tree opener is a ds IconButton that calls onOpenTree and is lg:hidden', async () => {
    const onOpenTree = vi.fn();
    await mount({ onOpenTree });
    const opener = header().querySelector('[data-slot="ds-icon-button"]') as HTMLButtonElement;
    expect(opener).toBeTruthy();
    expect(opener.getAttribute('aria-label')).toBe(koMessages.docs.openDocTree ?? opener.getAttribute('aria-label'));
    expect(opener.className.split(/\s+/)).toContain('lg:hidden');
    expect(opener.querySelector('[data-icon="left_panel_open"]')).not.toBeNull();
    await act(async () => { opener.click(); });
    expect(onOpenTree).toHaveBeenCalledTimes(1);
  });

  it('⭐the preview / markdown switch is two ds Buttons; the open one is aria-pressed and pressing the other flips it', async () => {
    await mount();
    const preview = btn('Preview')!;
    const markdown = btn('Markdown')!;
    expect(preview.getAttribute('data-slot')).toBe('ds-button');
    expect(markdown.getAttribute('data-slot')).toBe('ds-button');
    expect(preview.getAttribute('aria-pressed')).toBe('true');
    expect(markdown.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { markdown.click(); });
    expect(btn('Markdown')!.getAttribute('aria-pressed')).toBe('true');
    expect(btn('Preview')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('⭐«저장» is the ds primary Button: disabled while clean, calls onSave once when dirty', async () => {
    const onSave = vi.fn(async () => true);
    await mount({ onSave, isDirty: false });
    expect(btn('Save')!.disabled).toBe(true);
    await mount({ onSave, isDirty: true });
    const save = btn('Save')!;
    expect(save.getAttribute('data-slot')).toBe('ds-button');
    expect(save.className.split(/\s+/)).toContain('bg-ds-action');
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
