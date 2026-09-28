// @vitest-environment jsdom
/**
 * story #4339(까디르 4708 ② · PO 판단 (a)) — **마크다운 문서** 저장 경로에서도 부품 값이 산다: md → markdownToHtml → 편집기(실 확장 목록) →
 * getHTML → htmlToMarkdown → 같은 md.
 *
 * 재다가 나온 손실(develop부터): turndown은 규칙보다 먼저 «빈 노드»를 blankReplacement로 보내 버려, 내용 없는 부품 div인 **링크 카드 ·
 * 문서 임베드가 저장 때 통째로 사라졌다**(첨부만 특례로 살아 있었음). 이제 빈 부품은 content-converter의 EMPTY_PART_SERIALIZERS 한 곳에서
 * 보존하고, 아래 가드가 왕복 픽스처의 빈 부품 뿌리가 전부 거기 걸리는지 대조한다(새 빈 부품이 조용히 버려지지 않게).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { EMPTY_PART_SERIALIZERS, htmlToMarkdown, markdownToHtml } from './lib/content-converter';
import { makeDocEditor, partsOf, PARTS_FIXTURE } from './doc-editor-roundtrip.fixture';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ ws: 'ws-1', proj: 'proj-b' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));

const { DocContentRenderer } = await import('./doc-content-renderer');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 바뀐 노드마다 사례 하나 — 저장 형식(md)은 편집기 HTML을 htmlToMarkdown한 것. */
const CHANGED_PARTS: Record<string, string> = {
  linkCard: '<div data-type="embedBlock" data-url="https://example.com/"></div>',
  pageEmbed: '<div data-page-embed="" data-doc-id="64c2e43b-4323-4714-b49e-61f0b70fea60" data-title="공유 &quot;시각&quot; 검증" data-icon="📄" data-slug="ortega-visual-share"></div>',
  toggle: '<div data-type="toggleBlock" data-open="true"><div data-type="toggleSummary">토글 제목</div><div data-type="toggleContent"><p>토글 안 내용</p></div></div>',
  math: '<div data-type="mathBlock" data-latex="E=mc^2">E=mc^2</div>',
  wikiLink: '<p><span data-type="wikiLink" data-doc-id="d0c1d000-0000-4000-8000-000000000002" data-title="다른 문서" data-slug="other-doc">다른 문서</span></p>',
  columns: '<div data-type="columnsBlock" data-cols="2"><div data-type="columnBlock"><p>왼쪽</p></div><div data-type="columnBlock"><p>오른쪽</p></div></div>',
};

function editorRoundTrip(md: string): string {
  const editor = makeDocEditor(markdownToHtml(md));
  try {
    return htmlToMarkdown(editor.getHTML());
  } finally {
    editor.destroy();
  }
}

describe('마크다운 문서 저장 왕복 — 바뀐 부품마다(story #4339 · 까디르 4708 ②)', () => {
  it.each(Object.entries(CHANGED_PARTS))('⭐%s — md → 편집기 → md가 같고 · 부품 값이 산다', (_name, html) => {
    const md = htmlToMarkdown(html);
    expect(md, '저장 형식이 비지 않는다(예전: 링크 카드 · 문서 임베드는 "")').not.toBe('');
    expect(editorRoundTrip(md)).toBe(md);
    const [before] = partsOf(html);
    const [after] = partsOf(markdownToHtml(editorRoundTrip(md)));
    expect(after?.attrs).toMatchObject(before!.attrs);
  });

  it('⭐문단 사이의 링크 카드 · 문서 임베드도 저장에서 안 사라진다(예전: `a\\n\\nb`만 남음)', () => {
    const md = htmlToMarkdown(`<p>a</p>${CHANGED_PARTS.linkCard}${CHANGED_PARTS.pageEmbed}<p>b</p>`);
    expect(md).toContain('data-url="https://example.com/"');
    expect(md).toContain('data-slug="ortega-visual-share"');
    expect(editorRoundTrip(md)).toBe(md);
  });

  it('⭐가드 — 왕복 픽스처의 **빈 부품 뿌리**(자식 · 글 없는 부품)는 전부 EMPTY_PART_SERIALIZERS에 걸린다(새 빈 부품이 저장에서 조용히 버려지지 않게)', () => {
    const root = document.createElement('div');
    root.innerHTML = PARTS_FIXTURE;
    const emptyRoots = [...root.querySelectorAll<HTMLElement>('[data-type], [data-page-embed]')].filter((el) => el.childNodes.length === 0);
    expect(emptyRoots.length, '빈 부품을 실제로 모았다').toBeGreaterThanOrEqual(3);
    const uncaught = emptyRoots.filter((el) => !EMPTY_PART_SERIALIZERS.some((p) => p.matches(el))).map((el) => el.outerHTML.slice(0, 80));
    expect(uncaught).toEqual([]);
    for (const el of emptyRoots) expect(htmlToMarkdown(el.outerHTML), el.outerHTML.slice(0, 60)).not.toBe('');
  });

  it('속성 값은 escape되어 raw HTML 밖으로 새지 않는다(따옴표 · 꺾쇠)', () => {
    const md = htmlToMarkdown('<div data-type="embedBlock" data-url="https://e.com/?q=&quot;&gt;&lt;x"></div>');
    const [part] = partsOf(markdownToHtml(md));
    expect(part?.attrs['data-url']).toBe('https://e.com/?q="><x');
    expect(md).not.toMatch(/data-url="[^"]*"[^>]*"/);
  });
});

/** 속성 값 주입 탐침 — 따옴표 · 작은따옴표 · 꺾쇠 · 새 속성 모양. */
const PROBE = `x" data-url="javascript:alert(1)" y='z'><img src=x onerror=alert(1)>`;

function partRoots(html: string): HTMLElement[] {
  const root = document.createElement('div');
  root.innerHTML = html;
  return [...root.querySelectorAll<HTMLElement>('[data-type], [data-page-embed]')].filter(
    (el) => !el.parentElement?.closest('[data-type], [data-page-embed]'),
  );
}
const keyOf = (el: HTMLElement) => el.getAttribute('data-type') ?? 'pageEmbed';
const namesOf = (el: HTMLElement | undefined) => (el ? [...el.attributes].map((a) => a.name).sort() : []);
/** 저장(md) → 다시 읽기 → 같은 종류의 첫 부품 뿌리. */
function reparse(el: HTMLElement): HTMLElement | undefined {
  return partRoots(markdownToHtml(htmlToMarkdown(el.outerHTML))).find((p) => keyOf(p) === keyOf(el));
}

describe('주입 가드 — raw HTML로 남는 부품 속성은 값이 무엇이든 속성 경계를 못 넘는다(까디르 4708 · PO)', () => {
  it('⭐목록(EMPTY_PART_SERIALIZERS)의 부품마다 왕복 픽스처에 표본이 있다(새 부품이 탐침에서 빠지지 않게)', () => {
    const roots = partRoots(PARTS_FIXTURE);
    for (const part of EMPTY_PART_SERIALIZERS) expect(roots.some((el) => part.matches(el)), part.name).toBe(true);
  });

  it('⭐모든 부품 × 모든 속성에 같은 탐침 → 저장 → 다시 읽기: 속성 이름 집합이 깨끗한 저장과 같고 · 목록 부품은 값도 그대로', () => {
    const broken: string[] = [];
    for (const original of partRoots(PARTS_FIXTURE)) {
      const clean = namesOf(reparse(original));
      const isListed = EMPTY_PART_SERIALIZERS.some((p) => p.matches(original));
      for (const attr of [...original.attributes].map((a) => a.name)) {
        if (attr === 'data-type' || attr === 'data-page-embed') continue;
        const probed = original.cloneNode(true) as HTMLElement;
        probed.setAttribute(attr, PROBE);
        const back = reparse(probed);
        if (JSON.stringify(namesOf(back)) !== JSON.stringify(clean)) broken.push(`${keyOf(original)}.${attr}: ${JSON.stringify(namesOf(back))}`);
        else if (isListed && back?.getAttribute(attr) !== PROBE) broken.push(`${keyOf(original)}.${attr} value: ${JSON.stringify(back?.getAttribute(attr))}`);
      }
    }
    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('너비 있는 이미지의 src · alt도 같은 규칙(raw HTML img)', () => {
    const img = document.createElement('img');
    img.setAttribute('src', 'https://example.com/a.png');
    img.setAttribute('alt', PROBE);
    img.style.width = '50%';
    const md = htmlToMarkdown(img.outerHTML);
    const back = document.createElement('div');
    back.innerHTML = markdownToHtml(md);
    const parsed = back.querySelector('img');
    expect(namesOf(parsed ?? undefined)).toEqual(['alt', 'src', 'style']);
    expect(parsed?.getAttribute('alt')).toBe(PROBE);
  });
});

describe('수식 — 마크다운 저장 → 다시 열기 → 수식 값이 선다(유나 4708 대조판)', () => {
  /** 편집기(A)에서 저장한 md를 편집기(B)로 다시 연 뒤의 수식 글. */
  function reopenedLatex(html: string): string[] {
    const first = makeDocEditor(html);
    const saved = htmlToMarkdown(first.getHTML());
    first.destroy();
    const second = makeDocEditor(markdownToHtml(saved));
    try {
      const doc = second.getJSON() as JSONContent;
      return (doc.content ?? []).filter((n) => n.type === 'mathBlock').map((n) => (n.content ?? []).map((c) => c.text ?? '').join(''));
    } finally {
      second.destroy();
    }
  }
  const MATH = '<div data-type="mathBlock" data-latex="E = mc^2">E = mc^2</div>';
  it.each([
    ['단독', MATH],
    ['속성만(MCP 모양)', '<div data-type="mathBlock" data-latex="E = mc^2"></div>'],
    ['제목 뒤', `<h2>수식</h2>${MATH}`],
    ['문단 사이', `<p>앞</p>${MATH}<p>뒤</p>`],
    ['문서 임베드 뒤', `<div data-page-embed="" data-doc-id="x" data-title="T" data-icon="" data-slug="s"></div>${MATH}`],
    ['밑줄 · 역슬래시', '<div data-type="mathBlock" data-latex="x_1 + \\frac{a}{b}">x_1 + \\frac{a}{b}</div>'],
  ])('⭐%s', (_name, html) => {
    const expected = html.includes('frac') ? 'x_1 + \\frac{a}{b}' : 'E = mc^2';
    expect(reopenedLatex(html)).toEqual([expected]);
  });
});

describe('이미지 alt의 따옴표 — 불러오기에서 안 잘린다(저장 쪽 escapeAttr의 읽기 짝 · 유나 4708)', () => {
  it('⭐md `![a "b" c](…)` → markdownToHtml → 편집기 → alt 그대로', () => {
    const html = markdownToHtml('![작은 "따옴표" 그림](https://example.com/q.png)');
    const probe = document.createElement('div');
    probe.innerHTML = html;
    expect(probe.querySelector('img')?.getAttribute('alt')).toBe('작은 "따옴표" 그림');
    expect(probe.querySelector('img')?.getAttribute('src')).toBe('https://example.com/q.png');
    const editor = makeDocEditor(html);
    try {
      const reopened = document.createElement('div');
      reopened.innerHTML = editor.getHTML();
      expect(reopened.querySelector('img')?.getAttribute('alt')).toBe('작은 "따옴표" 그림');
    } finally {
      editor.destroy();
    }
  });
});

describe('보안 — 마크다운에 raw HTML로 남는 data-url은 읽을 때 4324 안전 도우미를 그대로 지난다(새 싱크 0)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

  async function renderMarkdown(md: string) {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <DocContentRenderer content={`${md}\n`} contentFormat="markdown" untitledEmbedLabel="제목 없음" embedNotFoundLabel="문서를 찾을 수 없어요" unsafeLinkLabel={koMessages.docs.embedLinkBlocked} unsafeFileLabel={koMessages.docs.attachFileBlocked} wikiLinkTargets={{}} />
        </NextIntlClientProvider>,
      );
    });
  }

  const IMAGE_AFTER = '<img src="https://example.com/after.png" alt="뒤 그림">';
  const RAW_HTML_BLOCKS: Record<string, string> = {
    ...Object.fromEntries(partRoots(PARTS_FIXTURE).map((el, i) => [`${keyOf(el)}#${i}`, el.outerHTML])),
    imageWithWidth: '<img src="https://example.com/w.png" alt="너비" style="width: 50%;">',
  };

  it.each(Object.entries(RAW_HTML_BLOCKS))('⭐%s 바로 뒤 마크다운 이미지가 읽기 화면에서 이미지로 선다(유나 4708 · 예전: HTML 블록에 먹혀 «![…](…)» 글자)', async (_name, block) => {
    const md = htmlToMarkdown(`${block}${IMAGE_AFTER}`);
    await renderMarkdown(md);
    expect(container.querySelector('img[alt="뒤 그림"]'), md).not.toBeNull();
    expect(container.textContent ?? '').not.toContain('![');
  });

  it('⭐마크다운 문서의 두 열이 읽기 화면에서 열 수(data-cols)를 가진다(sanitize가 dataCols를 통과 · 예전: 걷혀서 한 열로 쌓임)', async () => {
    const md = htmlToMarkdown('<div data-type="columnsBlock" data-cols="2"><div data-type="columnBlock"><p>왼쪽</p></div><div data-type="columnBlock"><p>오른쪽</p></div></div>');
    await renderMarkdown(md);
    expect(container.querySelector('[data-type="columnsBlock"]')?.getAttribute('data-cols')).toBe('2');
  });

  it('⭐javascript: 링크 카드를 저장(md) → 읽기 화면으로 그리면 그 주소로 가는 링크 · 틀이 없다', async () => {
    const md = htmlToMarkdown('<div data-type="embedBlock" data-url="javascript:alert(1)"></div>');
    expect(md, '값은 보존(판정은 읽을 때)').toContain('javascript:alert(1)');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <DocContentRenderer content={`${md}\n`} contentFormat="markdown" untitledEmbedLabel="제목 없음" embedNotFoundLabel="문서를 찾을 수 없어요" unsafeLinkLabel={koMessages.docs.embedLinkBlocked} unsafeFileLabel={koMessages.docs.attachFileBlocked} wikiLinkTargets={{}} />
        </NextIntlClientProvider>,
      );
    });
    for (const a of container.querySelectorAll('a')) expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i);
    for (const f of container.querySelectorAll('iframe')) expect(f.getAttribute('src') ?? '').not.toMatch(/^\s*javascript:/i);
    expect(container.textContent).toContain(koMessages.docs.embedLinkBlocked);
  });
});
