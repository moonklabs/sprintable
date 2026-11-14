// @vitest-environment jsdom
// story 4949 — the preview block of a permission card: Write → «쓰려는 내용» · Edit → «바꾸려는 줄», removed then added lines, what the Mac left out counted,
// folded after 8 rows with a button that names what it does, a secrets file saying nothing but why.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import type { PermissionPreview } from '@/lib/agent-permissions';
import { PermissionPreviewView, previewRows, PREVIEW_FOLDED_ROWS } from './permission-preview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const block = (over: Partial<PermissionPreview['blocks'][number]> = {}) => ({ removed: [], added: [], removed_more: 0, added_more: 0, ...over });
const WRITE = (n: number, more = 0): PermissionPreview => ({ op: 'write', blocks: [block({ added: Array.from({ length: n }, (_, i) => `line ${i + 1}`), added_more: more })], blocks_more: 0, replace_all: false, withheld: null });
const EDIT: PermissionPreview = { op: 'edit', blocks: [block({ removed: ['old a'], added: ['new a', 'new b'] })], blocks_more: 0, replace_all: false, withheld: null };

async function show(preview: PermissionPreview, locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><PermissionPreviewView preview={preview} /></NextIntlClientProvider>);
  });
}
const rows = () => [...container.querySelectorAll('[data-row]')] as HTMLElement[];
const toggle = () => container.querySelector('[data-testid="agent-permission-preview-toggle"]') as HTMLButtonElement | null;

describe('PermissionPreviewView (story 4949)', () => {
  it('⭐an Edit: «바꾸려는 줄», the removed lines first (−) then the added lines (+); no fold under the limit', async () => {
    await show(EDIT);
    expect(container.textContent).toContain('바꾸려는 줄');
    expect(rows().map((r) => r.dataset.row)).toEqual(['del', 'add', 'add']);
    expect(toggle()).toBeNull();
  });

  it('⭐a Write: «쓰려는 내용» and the lines as added; english screen says it in english (no Korean word on it)', async () => {
    await show(WRITE(3), 'en');
    expect(container.textContent).toContain('What it will write');
    expect(container.textContent).not.toMatch(/[가-힣]/);
    expect(rows().map((r) => r.dataset.row)).toEqual(['add', 'add', 'add']);
  });

  it('⭐over 8 rows it folds: the first 8, a button that says how many more, and «접기» after it opens (aria-expanded follows)', async () => {
    await show(WRITE(12, 6));
    expect(rows()).toHaveLength(PREVIEW_FOLDED_ROWS);
    expect(toggle()!.textContent).toBe('5줄 더 보기'); // 12 added + the «…6줄 더» note = 13 rows; 13 − 8
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle()!.click(); });
    expect(rows()).toHaveLength(13);
    expect(rows().at(-1)!.dataset.row).toBe('note');
    expect(rows().at(-1)!.textContent).toBe('…6줄 더');
    expect(toggle()!.textContent).toBe('접기');
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true');
    expect(toggle()!.className).toContain('touch:min-h-11');
  });

  it('what the Mac left out is counted, never guessed: removed · added · more edits · replace-all', () => {
    const t = (key: string, values?: Record<string, string | number>) => `${key}${values ? JSON.stringify(values) : ''}`;
    const r = previewRows({ op: 'edit', blocks: [block({ removed: ['a'], removed_more: 4, added: ['b'], added_more: 2 })], blocks_more: 2, replace_all: true, withheld: null }, t);
    expect(r.map((x) => `${x.kind}:${x.text}`)).toEqual(['del:a', 'note:preview.moreRemoved{"count":4}', 'add:b', 'note:preview.moreAdded{"count":2}', 'note:preview.moreEdits{"count":2}', 'note:preview.replaceAll']);
  });

  it('⭐a secrets file shows only why there are no lines (no rows, no fold)', async () => {
    await show({ op: 'write', blocks: [], blocks_more: 0, replace_all: false, withheld: 'sensitive_path' });
    expect(container.querySelector('[data-testid="agent-permission-preview-withheld"]')!.textContent).toBe('민감해 보이는 파일이라 내용은 보여 주지 않아요');
    expect(rows()).toHaveLength(0);
    expect(toggle()).toBeNull();
  });

  it('⭐the lines say in words that they are part of it and for reference — always with lines; a secrets file has its own words instead', async () => {
    await show(EDIT);
    expect(container.querySelector('[data-testid="agent-permission-preview-partial"]')!.textContent).toBe('일부만 보여 줘요 · 참고용이에요');
    await show(WRITE(12, 6), 'en');
    expect(container.querySelector('[data-testid="agent-permission-preview-partial"]')!.textContent).toBe('Only part of it is shown · for reference');
    await show({ op: 'write', blocks: [], blocks_more: 0, replace_all: false, withheld: 'sensitive_path' });
    expect(container.querySelector('[data-testid="agent-permission-preview-partial"]')).toBeNull();
  });

  it('an empty preview draws nothing', async () => {
    await show({ op: 'edit', blocks: [], blocks_more: 0, replace_all: false, withheld: null });
    expect(container.querySelector('[data-testid="agent-permission-preview"]')).toBeNull();
  });
});
