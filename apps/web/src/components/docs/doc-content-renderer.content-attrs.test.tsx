// @vitest-environment jsdom
// story #4323 — 렌더러가 문서 콘텐츠에서 읽는 속성(RENDERER_CONTENT_ATTRIBUTES)이 마크다운 sanitize 스키마를 지나 살아남고(빈 칸 0), URL 속성은 스킴을
// 거른다. 가드: 렌더러가 읽는 data-* 전부 = 콘텐츠 속성 ∪ 내부 표지(4316) · 콘텐츠 속성은 스키마가 요소별로 통과시킨다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ ws: 'ws-1', proj: 'proj-b' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));

import {
  DocContentRenderer, RENDERER_CONTENT_ATTRIBUTES, RENDERER_INTERNAL_MARKERS, docMarkdownSanitizeSchema, safeAttachmentDataUrl, safeHttpUrl,
} from './doc-content-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.restoreAllMocks(); });

async function render(content: string, format: 'html' | 'markdown') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocContentRenderer content={format === 'markdown' ? `${content}\n` : content} contentFormat={format} untitledEmbedLabel="제목 없음" embedNotFoundLabel="문서를 찾을 수 없어요" unsafeLinkLabel={koMessages.docs.embedLinkBlocked} unsafeFileLabel={koMessages.docs.attachFileBlocked} wikiLinkTargets={{}} />
      </NextIntlClientProvider>,
    );
  });
}
const FORMATS = ['html', 'markdown'] as const;

describe('콘텐츠 속성이 살아남는다(마크다운 · HTML)', () => {
  it.each(FORMATS)('⭐일반 링크 임베드(data-url) — 링크 카드로 그려짐(빈 칸 0) · %s', async (format) => {
    await render('<div data-type="embedBlock" data-url="https://example.com/page"></div>', format);
    const link = container.querySelector('[data-type="embedBlock"] a');
    expect(link?.getAttribute('href')).toBe('https://example.com/page');
  });

  it.each(FORMATS)('YouTube 주소는 틀(iframe)로 · %s', async (format) => {
    await render('<div data-type="embedBlock" data-url="https://www.youtube.com/watch?v=abc123DEF45"></div>', format);
    expect(container.querySelector('[data-type="embedBlock"] iframe')).not.toBeNull();
  });

  it.each(FORMATS)('⭐접기 블록 펼침 상태(data-open)가 남고 요약을 누르면 바뀜 · %s', async (format) => {
    await render('<div data-type="toggleBlock" data-open="true"><div data-type="toggleSummary">요약</div><div data-type="toggleContent">내용</div></div>', format);
    const block = container.querySelector('[data-type="toggleBlock"]')!;
    expect(block.getAttribute('data-open')).toBe('true');
    act(() => { (container.querySelector('[data-type="toggleSummary"]') as HTMLElement).click(); });
    expect(block.getAttribute('data-open')).toBe('false');
  });

  it.each(FORMATS)('⭐수식 블록 원문(data-latex)이 남아 글자 내용 없이도 그려짐 · %s', async (format) => {
    await render('<div data-type="mathBlock" data-latex="x^2 + 1"></div>', format);
    const block = container.querySelector('[data-type="mathBlock"]')!;
    expect(block.getAttribute('data-latex')).toBe('x^2 + 1');
    for (let i = 0; i < 60 && !block.innerHTML.trim(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(block.innerHTML.trim(), '빈 칸 아님(수식 또는 오류 상자)').not.toBe('');
  });
});

describe('URL 속성 스킴 거름(XSS 표)', () => {
  it.each(FORMATS.flatMap((f) => ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '/relative/path', 'JaVaScRiPt:alert(1)'].map((u) => [f, u] as const)))(
    '⭐%s — data-url %s → 링크 · 틀 0',
    async (format, url) => {
      await render(`<div data-type="embedBlock" data-url="${url.replace(/"/g, '&quot;').replace(/</g, '&lt;')}"></div>`, format);
      const block = container.querySelector('[data-type="embedBlock"]');
      expect(block?.querySelector('a, iframe') ?? null).toBeNull();
      // 값이 살아 들어온 경우엔 막힘 카드(4324). HTML의 `<script>` 값은 DOMPurify가 속성째 걷어 빈 칸(누를 것 0은 같음).
      if (block?.getAttribute('data-url')) expect(block.textContent).toContain(koMessages.docs.embedLinkBlocked);
      for (const a of container.querySelectorAll('a')) expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*(javascript|data):/i);
    },
  );

  it.each(FORMATS)('⭐%s — data-file-data가 javascript:면 눌러도 그 주소로 가는 링크를 안 만든다', async (format) => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.getAttribute('href') ?? ''); });
    await render('<div data-type="fileAttachment" data-filename="a.html" data-size="10" data-file-data="javascript:alert(1)"></div>', format);
    const card = container.querySelector('[data-type="fileAttachment"]') as HTMLElement;
    act(() => { card.click(); });
    expect(clicked.filter((h) => /^\s*javascript:/i.test(h))).toEqual([]);
  });

  it('data: 첨부는 그대로 내려받기 링크로(회귀 0)', async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.getAttribute('href') ?? ''); });
    await render('<div data-type="fileAttachment" data-filename="a.txt" data-size="3" data-file-data="data:text/plain;base64,YWJj"></div>', 'html');
    act(() => { (container.querySelector('[data-type="fileAttachment"]') as HTMLElement).click(); });
    expect(clicked).toEqual(['data:text/plain;base64,YWJj']);
  });

  // 도우미 전수 표는 `lib/safe-content-url.test.ts`(story #4324) — 여기선 렌더러가 다시 내보내는 것이 같은 도우미인지만.
  it('스킴 판정 단위(렌더러 재수출 = 4324 도우미)', () => {
    expect(safeHttpUrl(' https://a.test/x ')).toBe('https://a.test/x');
    expect(safeHttpUrl('http://a.test/y')).toBe('http://a.test/y');
    for (const bad of ['javascript:x', 'data:text/html,x', 'ftp://a', '/rel', '', 'vbscript:x']) expect(safeHttpUrl(bad), bad).toBeNull();
    expect(safeAttachmentDataUrl('data:image/png;base64,AA')).toBe('data:image/png;base64,AA');
    for (const bad of ['javascript:x', 'https://a', '', 'data:text/html,x']) expect(safeAttachmentDataUrl(bad), bad).toBeNull();
  });
});

// ─── 가드 ───
const SRC = readFileSync(path.resolve(__dirname, 'doc-content-renderer.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** 렌더러가 «읽는» data-* 이름: getAttribute · 선택자(querySelector/All · closest) · props/rest 색인. 붙이는 쪽(setAttribute · 문자열 조립)은 뺀다. */
function readDataAttributes(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/getAttribute\('(data-[a-z-]+)'\)/g)) out.add(m[1]!);
  for (const m of src.matchAll(/(?:querySelectorAll|querySelector|closest)(?:<[^>]*>)?\('([^']*)'\)/g)) for (const a of m[1]!.matchAll(/\[(data-[a-z-]+)/g)) out.add(a[1]!);
  for (const m of src.matchAll(/(?:rest|props|p)\['(data-[a-z-]+)'\]/g)) out.add(m[1]!);
  return out;
}
const camel = (attr: string) => attr.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
function schemaMissing(schema: { attributes?: Record<string, readonly unknown[]> }): string[] {
  const missing: string[] = [];
  for (const entry of RENDERER_CONTENT_ATTRIBUTES) {
    if (entry.htmlOnly) continue;
    for (const el of entry.elements) if (!(schema.attributes?.[el] ?? []).includes(camel(entry.attr))) missing.push(`${el}:${entry.attr}`);
  }
  return missing;
}

describe('가드 — 렌더러가 읽는 속성 ↔ 두 목록 · 스키마', () => {
  it('⭐렌더러가 읽는 data-* 전부가 콘텐츠 속성 또는 내부 표지 목록에 있고 · 콘텐츠 속성 목록에 안 읽는 것이 없다', () => {
    const read = readDataAttributes(SRC);
    const content = new Set(RENDERER_CONTENT_ATTRIBUTES.map((e) => e.attr));
    const internal = new Set<string>(RENDERER_INTERNAL_MARKERS);
    expect([...read].filter((a) => !content.has(a) && !internal.has(a)), '목록 밖에서 읽는 속성').toEqual([]);
    expect([...content].filter((a) => !read.has(a)), '안 읽는데 목록에 있는 콘텐츠 속성').toEqual([]);
    for (const a of content) expect(internal.has(a), `${a}는 콘텐츠이자 내부 표지일 수 없음`).toBe(false);
  });

  it('⭐마크다운 스키마가 콘텐츠 속성을 요소별로 통과시킨다(HTML 전용 제외)', () => {
    expect(schemaMissing(docMarkdownSanitizeSchema as unknown as { attributes?: Record<string, readonly unknown[]> })).toEqual([]);
  });

  it('양성 대조: 새로 읽는 속성 · 스키마에서 빠진 속성을 가드가 잡는다', () => {
    const read = readDataAttributes(`${SRC}\nconst x = el.getAttribute('data-brand-new'); root.querySelectorAll('[data-other-new="1"]');`);
    expect(read.has('data-brand-new')).toBe(true);
    expect(read.has('data-other-new')).toBe(true);
    const schema = docMarkdownSanitizeSchema as unknown as { attributes: Record<string, readonly unknown[]> };
    const broken = { attributes: { ...schema.attributes, div: (schema.attributes['div'] ?? []).filter((a) => a !== 'dataUrl') } };
    expect(schemaMissing(broken)).toContain('div:data-url');
  });
});
