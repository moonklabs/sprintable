// @vitest-environment jsdom
// story #4324(critical · 저장형 XSS) — 문서 콘텐츠 속성에서 온 주소를 href · src로 쓰기 전 스킴 거름. HTML 형식은 DOMPurify가 data-* 값을 그대로 통과시키고
// CSP가 'unsafe-inline'이라, 거르지 않으면 `javascript:` 값이 누른 사람 브라우저에서 실행된다.
// - data-url(일반 링크 임베드): http/https만 링크 카드 · YouTube/Figma 틀. 그 밖은 «열 수 없는 링크예요» 비활성 카드(날 주소 안 보임).
// - data-file-data(옛 첨부 본문): data: + 실행되지 않는 MIME만 내려받기. 그 밖은 파일 이름 + «이 파일은 열 수 없어요» 비활성 카드(누름 0).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ ws: 'ws-1', proj: 'proj-b' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));

import { DocContentRenderer, safeAttachmentDataUrl, safeHttpUrl } from './doc-content-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const LINK_BLOCKED = koMessages.docs.embedLinkBlocked;
const FILE_BLOCKED = koMessages.docs.attachFileBlocked;

let container: HTMLDivElement;
let root: Root;
let clicked: string[];
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.getAttribute('href') ?? ''); });
  consoleError = vi.spyOn(console, 'error');
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.restoreAllMocks(); });

const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
async function render(content: string, format: 'html' | 'markdown') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocContentRenderer
          content={format === 'markdown' ? `${content}\n` : content}
          contentFormat={format}
          untitledEmbedLabel="제목 없음"
          embedNotFoundLabel="문서를 찾을 수 없어요"
          unsafeLinkLabel={LINK_BLOCKED}
          unsafeFileLabel={FILE_BLOCKED}
          wikiLinkTargets={{}}
        />
      </NextIntlClientProvider>,
    );
  });
}
const FORMATS = ['html', 'markdown'] as const;
const HOSTILE = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  '   javascript:alert(1)',
  '\u0001javascript:alert(1)',
  'vbscript:msgbox(1)',
  // `</`가 든 값은 DOMPurify가 속성째 걷어 렌더러까지 안 온다(그것대로 안전) — 렌더러 거름을 실제로 지나가게 base64 형태로.
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'data:text/html,<b onmouseover=alert(1)>x',
  'data:image/svg+xml,<svg onload=alert(1)>',
  '/relative/path',
];
const noDangerousHref = () => {
  for (const el of container.querySelectorAll('[href], [src]')) {
    const v = (el.getAttribute('href') ?? el.getAttribute('src') ?? '').replace(/[\u0000- ]/g, '');
    expect(v, el.outerHTML.slice(0, 80)).not.toMatch(/^(javascript|vbscript|data:text\/html|data:image\/svg)/i);
  }
};

describe('data-url(일반 링크 임베드) — http/https만', () => {
  it.each(FORMATS.flatMap((f) => HOSTILE.map((u) => [f, u] as const)))('⭐%s · %j → 링크 · 틀 0 · 날 주소 안 보임', async (format, url) => {
    await render(`<div data-type="embedBlock" data-url="${attr(url)}"></div>`, format);
    const block = container.querySelector('[data-type="embedBlock"]');
    expect(block?.querySelector('a, iframe') ?? null).toBeNull();
    noDangerousHref();
    expect(container.textContent).not.toContain('alert(1)');
    expect(container.textContent).not.toContain('msgbox');
    if (format === 'html') expect(block?.textContent).toContain(LINK_BLOCKED); // 마크다운은 develop 스키마가 data-url을 걷어 원래 빈 칸(4323이 연다)
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('정상 값 그대로(회귀 0): https 링크 카드 · YouTube · Figma 틀', async () => {
    await render('<div data-type="embedBlock" data-url="https://example.com/page"></div>', 'html');
    expect(container.querySelector('[data-type="embedBlock"] a')?.getAttribute('href')).toBe('https://example.com/page');
    await render('<div data-type="embedBlock" data-url="https://www.youtube.com/watch?v=abc123DEF45"></div>', 'html');
    expect(container.querySelector('[data-type="embedBlock"] iframe')?.getAttribute('src')).toMatch(/^https:\/\/www\.youtube\.com\/embed\//);
    await render('<div data-type="embedBlock" data-url="https://www.figma.com/file/abc/Design"></div>', 'html');
    expect(container.querySelector('[data-type="embedBlock"] iframe')?.getAttribute('src')).toMatch(/^https:\/\/www\.figma\.com\/embed/);
  });
});

describe('data-file-data(옛 첨부 본문) — data: + 실행되지 않는 MIME만', () => {
  const HOSTILE_FILE = [...HOSTILE.filter((u) => u !== '/relative/path'), 'https://evil.test/x', 'data:application/xhtml+xml,<x/>'];
  it.each(FORMATS.flatMap((f) => HOSTILE_FILE.map((u) => [f, u] as const)))('⭐%s · %j → 누름 · 내려받기 0 · 이름 + «이 파일은 열 수 없어요»', async (format, value) => {
    await render(`<div data-type="fileAttachment" data-filename="a.pdf" data-size="10" data-file-data="${attr(value)}"></div>`, format);
    const card = container.querySelector('[data-type="fileAttachment"]') as HTMLElement;
    act(() => { card.click(); card.firstElementChild?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(clicked, '만들어 누른 링크 0').toEqual([]);
    expect(card.textContent).toContain('a.pdf');
    expect(card.textContent).toContain(FILE_BLOCKED);
    expect(card.querySelector('a')).toBeNull();
    noDangerousHref();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each(FORMATS)('정상 data: 첨부는 그대로 내려받기(회귀 0) · %s', async (format) => {
    await render('<div data-type="fileAttachment" data-filename="a.txt" data-size="3" data-file-data="data:text/plain;base64,YWJj"></div>', format);
    act(() => { (container.querySelector('[data-type="fileAttachment"]') as HTMLElement).click(); });
    expect(clicked).toEqual(['data:text/plain;base64,YWJj']);
    expect(container.textContent).not.toContain(FILE_BLOCKED);
  });
});

describe('스킴 판정 단위', () => {
  it('safeHttpUrl: http/https 절대 주소만 · 정규화', () => {
    expect(safeHttpUrl(' https://a.test/x ')).toBe('https://a.test/x');
    expect(safeHttpUrl('HTTP://A.test')).toBe('http://a.test/');
    for (const bad of [...HOSTILE, 'ftp://a', '', 'mailto:a@b']) expect(safeHttpUrl(bad), JSON.stringify(bad)).toBeNull();
  });
  it('safeAttachmentDataUrl: data: + 실행 안 되는 MIME만', () => {
    for (const ok of ['data:application/pdf;base64,AA', 'data:image/png;base64,AA', 'data:text/plain,hi', 'data:;base64,AA']) expect(safeAttachmentDataUrl(ok), ok).toBe(ok);
    for (const bad of [...HOSTILE, 'https://a', 'data:TEXT/HTML;base64,AA', 'data:application/xhtml+xml,x', 'data:text/javascript,x']) expect(safeAttachmentDataUrl(bad), JSON.stringify(bad)).toBeNull();
  });
});
