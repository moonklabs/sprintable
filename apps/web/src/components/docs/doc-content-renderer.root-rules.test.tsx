// @vitest-environment jsdom
// story #4316 — 렌더러 뿌리 본문 규칙(`[&_p]` · `[&_a]` = `.root p` / `.root a` 0,1,1) × 렌더러가 끼워 넣는 부품(`data-doc-part`).
// 부품이 선언한 색 · 밑줄 · 크기가 계산값으로 닿는지(두 테마 · 마크다운 · HTML)를 실 Tailwind CSS로 잰다(tailwind-cascade.test-helper).
// 표 맨 위는 양성 대조: 본문 문단 · 본문 링크는 여전히 뿌리 규칙이 이긴다(본문 모양 무변).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { loadTailwindCascade, type Cascade } from './lib/tailwind-cascade.test-helper';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ ws: 'ws-1', proj: 'proj-b' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));

import { DocContentRenderer } from './doc-content-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const TARGETS = { 'design-doc': 'design-doc' };
const REFS = '<span data-ref="fg92" class="text-foreground/92">r</span><span data-ref="fg" class="text-foreground">r</span><span data-ref="brand" class="text-brand-text">r</span>';
const HTML = [
  '<p>본문 문단 <a href="https://example.com">본문 링크</a></p>',
  '<div data-page-embed data-title="살아 있는 문서" data-slug="design-doc"></div>',
  '<div data-page-embed data-title="지운 문서" data-slug="gone-doc"></div>',
  '<div data-type="embedBlock" data-url="https://example.com/x"></div>',
  '<div data-type="fileAttachment" data-filename="a.pdf" data-size="2048" data-asset-id="asset-1"></div>',
].join('');
const MD = '본문 문단 [본문 링크](https://example.com)\n\n<div data-page-embed data-title="살아 있는 문서" data-slug="design-doc"></div>\n\n<div data-page-embed data-title="지운 문서" data-slug="gone-doc"></div>\n';

async function render(content: string, format: 'html' | 'markdown') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocContentRenderer content={content} contentFormat={format} untitledEmbedLabel="제목 없음" embedNotFoundLabel="문서를 찾을 수 없어요" unsafeLinkLabel="열 수 없는 링크예요" unsafeFileLabel="이 파일은 열 수 없어요" wikiLinkTargets={TARGETS} />
        <div dangerouslySetInnerHTML={{ __html: REFS }} />
      </NextIntlClientProvider>,
    );
  });
  const cascade = await loadTailwindCascade(container);
  expect(cascade.unparsable(), '하네스가 못 읽은 선택자 0').toEqual([]);
  return cascade;
}
const q = (sel: string) => { const el = container.querySelector(sel); expect(el, sel).not.toBeNull(); return el!; };
const ref = (c: Cascade, name: string, theme: 'light' | 'dark') => c.computed(q(`[data-ref="${name}"]`), 'color', theme);
const THEMES = ['light', 'dark'] as const;

describe.each([['html', HTML], ['markdown', MD]] as const)('뿌리 본문 규칙 × 부품 — %s', (format, content) => {
  it('⭐양성 대조(표 맨 위): 본문 문단 · 링크는 여전히 뿌리 규칙이 이긴다 — 본문 모양 무변', async () => {
    const c = await render(content, format);
    const bodyP = q('.doc-renderer > p');
    const bodyA = q('.doc-renderer a[href^="https://example.com"]:not([data-doc-internal-link])');
    for (const t of THEMES) {
      expect(c.computed(bodyP, 'color', t), `${t} 본문 문단`).toBe(ref(c, 'fg92', t));
      expect(c.computed(bodyA, 'color', t), `${t} 본문 링크 색`).toBe(ref(c, 'brand', t));
      expect(c.computed(bodyA, 'text-decoration-line', t), `${t} 본문 링크 밑줄`).toBe('underline');
    }
    expect(c.winner(bodyP, 'color')).toMatch(/_p/);
    expect(c.winner(bodyA, 'color')).toMatch(/_a/);
  });

  it('⭐없는 문서 카드: 문구 · 제목이 선언한 muted 색이 닿는다(뿌리 문단 색에 안 짐)', async () => {
    const c = await render(content, format);
    for (const sel of ['[data-embed-state="not-found"] p:first-child', '[data-embed-state="not-found"] p:last-child']) {
      const el = q(sel);
      for (const t of THEMES) expect(c.computed(el, 'color', t), `${t} ${sel}`).toBe(c.declared(el, 'color', t));
    }
  });

  // 뿌리 `[&_p]:leading-7`도 부품 문단의 선언(text-sm · text-xs가 함께 정하는 줄 높이)을 덮던 것 — 카드 문단은 자기 선언 줄 높이.
  it('⭐부품 문단 줄 높이 = 선언(text-sm/xs 줄 높이) · 본문 문단은 여전히 leading-7', async () => {
    const c = await render(content, format);
    // 표지가 아니라 부품 자기 정체로 고른다(표지를 빠뜨리면 이 목록에서 빠져 통과해 버리는 것을 막음).
    const parts = [...container.querySelectorAll('[data-page-embed] p, [data-type="fileAttachment"] p, [data-type="embedBlock"] p')];
    expect(parts.length).toBeGreaterThan(0);
    for (const el of parts) expect(c.computed(el, 'line-height', 'light'), el.textContent ?? '').toBe(c.declared(el, 'line-height', 'light'));
    expect(c.computed(q('.doc-renderer > p'), 'line-height', 'light')).toMatch(/1\.75rem|calc\(var\(--spacing\) \* 7\)|calc\(.*7\)/);
  });

  it('⭐작동 임베드 카드: 링크 · 제목 · 경로 줄 밑줄 0 · 선언 색(card-foreground)', async () => {
    const c = await render(content, format);
    const a = q('[data-page-embed]:not([data-embed-state]) a');
    for (const t of THEMES) {
      expect(c.computed(a, 'color', t), t).toBe(c.declared(a, 'color', t));
      for (const el of [a, ...a.querySelectorAll('p')]) expect(c.computed(el, 'text-decoration-line', t), `${t} ${el.tagName}`).toBe('none');
    }
  });

  if (format === 'html') {
    it('⭐일반 embedBlock 링크 카드 · 첨부 카드: 밑줄 0 · 선언 크기 그대로', async () => {
      const c = await render(content, format);
      const link = q('[data-type="embedBlock"] a');
      const fileP = q('[data-type="fileAttachment"] p');
      for (const t of THEMES) {
        // 유나 결정: 일반 링크 카드는 brand 글자색(명시 선언이 닿음) · 밑줄 0.
        expect(c.computed(link, 'color', t), `${t} 일반 링크 카드 글자색`).toBe(ref(c, 'brand', t));
        expect(c.computed(link, 'text-decoration-line', t), t).toBe('none');
        expect(c.computed(link, 'font-size', t), t).toBe(c.declared(link, 'font-size', t));
        expect(c.computed(fileP, 'text-decoration-line', t), t).toBe('none');
        expect(c.computed(fileP, 'font-size', t), t).toBe(c.declared(fileP, 'font-size', t));
      }
      // 부품을 표지가 아니라 자기 정체(data-type)로 골라 잰다 — 표지를 빠뜨린 부품도 이 칸에서 걸린다.
      for (const el of container.querySelectorAll('[data-type="fileAttachment"] p, [data-page-embed] p')) {
        expect(c.computed(el, 'line-height', 'light'), el.textContent ?? '').toBe(c.declared(el, 'line-height', 'light'));
      }
    });
  }
});

// 표지 전수: 렌더러가 스스로 만드는 부품 뿌리는 모두 `data-doc-part`를 단다(지금 p · a가 없는 부품도 — 뒤에 문단 · 링크가 들어와도 뿌리 규칙 밖).
describe('부품 표지 전수(data-doc-part)', () => {
  async function renderRaw(content: string, publicMode = false) {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <DocContentRenderer content={content} contentFormat="html" publicMode={publicMode} untitledEmbedLabel="제목 없음" embedNotFoundLabel="문서를 찾을 수 없어요" unsafeLinkLabel="열 수 없는 링크예요" unsafeFileLabel="이 파일은 열 수 없어요" wikiLinkTargets={TARGETS} publicImageLabel="이미지" />
        </NextIntlClientProvider>,
      );
    });
  }
  it.each([
    ['page-embed', '<div data-page-embed data-title="t" data-slug="design-doc"></div>', '[data-page-embed]'],
    ['embed', '<div data-type="embedBlock" data-url="https://example.com/x"></div>', '[data-type="embedBlock"]'],
    ['file', '<div data-type="fileAttachment" data-filename="a.pdf" data-size="1" data-asset-id="asset-1"></div>', '[data-type="fileAttachment"]'],
    ['math', '<div data-type="mathBlock" data-latex="x^2"></div>', '[data-type="mathBlock"]'],
  ] as const)('⭐%s 부품 뿌리에 표지', async (kind, html, sel) => {
    await renderRaw(html);
    expect(container.querySelector(sel)?.getAttribute('data-doc-part')).toBe(kind);
  });

  it('⭐공개 보기 이미지 자리 표시에 표지', async () => {
    await renderRaw('<p><img src="https://example.com/a.png" alt="그림"></p>', true);
    const ph = [...container.querySelectorAll('[data-doc-part="image-placeholder"]')];
    expect(ph).toHaveLength(1);
    expect(ph[0]!.textContent).toContain('그림');
  });
});

// PO 15:00Z · 15:03Z — 렌더러가 스스로 붙이고 스스로 믿는 내부 표지는 글쓴이 입력에서 전부 걷힌다: HTML은 DOMPurify FORBID_ATTR(RENDERER_INTERNAL_MARKERS) ·
// 마크다운은 sanitize 스키마에 없음(`data-doc-internal-link`만 스키마를 지나지만 렌더러 nonce 없는 표지는 `a`가 안 믿고 속성도 안 남김).
import { RENDERER_INTERNAL_MARKERS } from './doc-content-renderer';

describe('글쓴이가 적은 렌더러 내부 표지는 걷힌다', () => {
  const cases = RENDERER_INTERNAL_MARKERS.flatMap((m) => (['html', 'markdown'] as const).map((f) => [m, f] as const));
  it.each(cases)('⭐%s — %s: 글쓴이 문단 · 링크에서 속성 0 · 그 글은 본문 모양', async (marker, format) => {
    const content = `<p ${marker}="design-doc">작성 문단 <a ${marker}="design-doc" href="https://example.com/w">작성 링크</a></p>${format === 'markdown' ? '\n' : ''}`;
    const c = await render(content, format);
    const p = [...container.querySelectorAll('.doc-renderer p')].find((el) => el.textContent?.includes('작성 문단'))!;
    const a = [...container.querySelectorAll('.doc-renderer a')].find((el) => el.textContent === '작성 링크')!;
    expect(p, '글쓴이 문단').toBeDefined();
    expect(a, '글쓴이 링크').toBeDefined();
    expect(p.hasAttribute(marker), `문단 ${marker}`).toBe(false);
    expect(a.hasAttribute(marker), `링크 ${marker}`).toBe(false);
    expect(c.computed(p, 'color', 'light')).toBe(ref(c, 'fg92', 'light'));
    expect(c.computed(a, 'text-decoration-line', 'light')).toBe('underline');
  });

  it('표지 목록 = 렌더러가 붙이는 data-doc-*/data-embed-state 전부(새 표지가 목록 밖으로 새지 않게)', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    // 주석은 뺀다(주석엔 에디터 콘텐츠 속성 설명 · 예: data-doc-id가 나온다 — 렌더러가 붙이는 표지가 아님).
    const src = readFileSync(path.resolve(__dirname, 'doc-content-renderer.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const set = new Set<string>();
    for (const m of src.matchAll(/(?:setAttribute\('|\s)(data-doc-[a-z-]+|data-embed-state)(?=['=\s"])/g)) set.add(m[1]!);
    expect([...set].sort()).toEqual([...RENDERER_INTERNAL_MARKERS].sort());
  });
});
