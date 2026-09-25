// @vitest-environment jsdom
// story #4324(까디르 QA ① ②) — 편집기 노드의 두 싱크도 렌더러와 같은 도우미를 거친다.
// ① 링크 임베드 폴백(`embed-node.tsx`): http/https만 `a[href]` · 그 밖은 링크 없이 «열 수 없는 링크예요».
// ② 옛 첨부 본문(`file-node.tsx`): 허용 MIME의 data:만 내려받기 링크 · 그 밖은 링크를 만들지 않고 안내.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNodeViewProps } from '@tiptap/react';
import koMessages from '../../../../messages/ko.json';

const addToast = vi.fn();
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast }) }));
vi.mock('@tiptap/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tiptap/react')>()),
  NodeViewWrapper: ({ children, ...rest }: { children: React.ReactNode }) => <div {...rest}>{children}</div>,
}));

import { EmbedView } from './embed-node';
import { FileAttachmentView } from './file-node';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let clicked: string[];
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  clicked = [];
  addToast.mockReset();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.getAttribute('href') ?? ''); });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.restoreAllMocks(); });

function props(attrs: Record<string, unknown>): ReactNodeViewProps {
  return { node: { attrs }, updateAttributes: vi.fn(), selected: false } as unknown as ReactNodeViewProps;
}
async function render(el: React.ReactElement) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{el}</NextIntlClientProvider>);
  });
}

describe('① 편집기 링크 임베드 폴백', () => {
  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'vbscript:x', 'data:text/html,<b>', '//evil.example/x'])(
    '⭐%j → a[href] 0 · «열 수 없는 링크예요»',
    async (url) => {
      await render(<EmbedView {...props({ url })} />);
      expect(container.querySelector('a[href]')).toBeNull();
      expect(container.textContent).toContain(koMessages.docs.embedLinkBlocked);
    },
  );

  it('https 링크는 그대로 링크(회귀 0)', async () => {
    await render(<EmbedView {...props({ url: 'https://example.com/page' })} />);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/page');
  });
});

describe('② 편집기 옛 첨부 내려받기', () => {
  const download = () => container.querySelector(`button[aria-label="${koMessages.docs.attachDownload}"]`) as HTMLButtonElement;

  it.each(['data:text/html,<script>1</script>', 'data:image/svg+xml,<svg/>', 'data:text/\thtml,<b>', 'data:;base64,AA'])(
    '⭐%j → 내려받기 링크 0 · 안내',
    async (data) => {
      await render(<FileAttachmentView {...props({ filename: 'a.html', size: 10, mimeType: 'text/html', data, assetId: null })} />);
      await act(async () => { download().click(); });
      expect(clicked).toEqual([]);
      expect(addToast).toHaveBeenCalledWith({ type: 'info', title: koMessages.docs.attachFileBlocked });
    },
  );

  it('pdf 옛 첨부는 그대로 내려받기(회귀 0)', async () => {
    await render(<FileAttachmentView {...props({ filename: 'a.pdf', size: 10, mimeType: 'application/pdf', data: 'data:application/pdf;base64,JVBERi0=', assetId: null })} />);
    await act(async () => { download().click(); });
    expect(clicked).toEqual(['data:application/pdf;base64,JVBERi0=']);
    expect(addToast).not.toHaveBeenCalled();
  });
});
