// @vitest-environment jsdom
//
// story #4390 — 빈 폴더를 펼치면 자리 글이 한국어 화면에서도 영어 «No child docs»였다: TreeNode 기본값이 영어 문장이고
// 유일한 호출부(docs-client-layout)가 emptyFolderLabel을 안 넘겼다. 이제 로케일 문장(docs.noChildDocs) · 넘기면 그 값.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { DocTree } from './doc-tree';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const FOLDER = { id: 'f1', parent_id: null, title: '회의록', slug: 'f1', icon: null, sort_order: 0, is_folder: true };

function openEmptyFolder(locale: 'ko' | 'en', emptyFolderLabel?: string): string {
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <DocTree docs={[FOLDER]} selectedSlug={null} onSelect={() => {}} projectId="p1" emptyFolderLabel={emptyFolderLabel} />
      </NextIntlClientProvider>,
    );
  });
  // 폴더는 기본으로 펼쳐져 있다(use-tree-expanded: 접은 목록에 없으면 펼침) — 누르면 접힌다.
  expect(container.querySelector('[data-doc-id="f1"]')).not.toBeNull();
  const p = [...container.querySelectorAll('p')].find((el) => el.className.includes('italic'));
  return p?.textContent ?? '';
}

describe('문서 트리 빈 폴더 자리 글([SID:4390])', () => {
  it('한국어 화면 — 로케일 문장 · 영어 0', () => {
    const text = openEmptyFolder('ko');
    expect(text).toBe(koMessages.docs.noChildDocs);
    expect(text).not.toMatch(/[A-Za-z]/);
  });

  it('영어 화면 — 영어 문장', () => {
    expect(openEmptyFolder('en')).toBe(enMessages.docs.noChildDocs);
  });

  it('호출부가 넘기면 그 값', () => {
    expect(openEmptyFolder('ko', '비어 있음')).toBe('비어 있음');
  });
});
