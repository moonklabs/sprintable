// @vitest-environment jsdom
//
// story 4892 (UI-9 상세 열) — «읽기 | 고치기»: ONE labelled pair that replaces the two separately found links (the reader's «편집» and the editor's icon-only eye).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DocModeSwitch } from './doc-mode-switch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const props = { readHref: '/w/p/docs/x/view', editHref: '/w/p/docs/x', readLabel: '읽기', editLabel: '고치기', groupLabel: '읽기·고치기 전환' };
async function mount(mode: 'read' | 'edit') {
  await act(async () => { root.render(<DocModeSwitch mode={mode} {...props} />); });
}
const links = () => [...container.querySelectorAll('a')] as HTMLAnchorElement[];

describe('DocModeSwitch', () => {
  it('⭐one named group with the two labelled links, each to its own screen', async () => {
    await mount('read');
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('읽기·고치기 전환');
    expect(links().map((a) => a.textContent)).toEqual(['읽기', '고치기']);
    expect(links().map((a) => a.getAttribute('href'))).toEqual(['/w/p/docs/x/view', '/w/p/docs/x']);
  });

  it('⭐the current side carries aria-current="page" and the secondary look; the other is quiet with no aria-current', async () => {
    await mount('read');
    expect(links().map((a) => a.getAttribute('aria-current'))).toEqual(['page', null]);
    expect(links()[0]!.className.split(/\s+/)).toContain('border-ds-line-control');
    expect(links()[1]!.className.split(/\s+/)).toContain('border-transparent');
    await mount('edit');
    expect(links().map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page']);
    expect(links()[1]!.className.split(/\s+/)).toContain('border-ds-line-control');
  });

  it('both sides are ds buttons', async () => {
    await mount('edit');
    for (const a of links()) expect(a.getAttribute('data-slot')).toBe('ds-button');
  });
});
