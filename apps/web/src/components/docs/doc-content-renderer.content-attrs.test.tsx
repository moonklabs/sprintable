// @vitest-environment jsdom
// story #4323 — 렌더러가 문서 콘텐츠에서 읽는 속성(RENDERER_CONTENT_ATTRIBUTES)이 마크다운 sanitize 스키마를 지나 살아남고(빈 칸 0), URL 속성은 스킴을
// 거른다. 가드: 렌더러가 읽는 data-* 전부 = 콘텐츠 속성 ∪ 내부 표지(4316) · 콘텐츠 속성은 스키마가 요소별로 통과시킨다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
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
const SRC = readFileSync(path.resolve(__dirname, 'doc-content-renderer.tsx'), 'utf8');

// story #4338(까디르 4698 기록) — 정규식으로 홑따옴표 getAttribute · 선택자 · 대괄호 모양만 보던 것을 AST로: 겹따옴표 · 템플릿 ·
// `dataset.fooBar` · hast `properties.dataFoo`/`properties['dataFoo']` · 구조분해까지 «읽기»로 센다. 붙이는 쪽(setAttribute ·
// 문자열 조립)은 읽기가 아니다.
interface AttrRead {
  attr: string;
  node: ts.Node;
  /** 선택자에서 온 읽기면 그 선택자가 붙인 태그(`img[data-asset-id]` → img · 없으면 null). */
  tag: string | null;
}

const kebab = (camelName: string) => camelName.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const literalText = (n: ts.Node | undefined): string | null =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

function contentAttributeReads(src: string): AttrRead[] {
  const file = ts.createSourceFile('x.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: AttrRead[] = [];
  const visit = (n: ts.Node) => {
    // 메서드 이름은 `el.getAttribute` · `el['getAttribute']` 둘 다(까디르 4705 ①). DOM 속성 이름은 대소문자를 가리지 않아 소문자로 맞춘다.
    const method = ts.isCallExpression(n)
      ? ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text
        : ts.isElementAccessExpression(n.expression) ? literalText(n.expression.argumentExpression) : null
      : null;
    if (method !== null && ts.isCallExpression(n)) {
      const arg = literalText(n.arguments[0]);
      const lower = arg?.toLowerCase() ?? null;
      if (lower !== null && (method === 'getAttribute' || method === 'hasAttribute') && lower.startsWith('data-')) {
        out.push({ attr: lower, node: n, tag: null });
      }
      if (lower !== null && ['querySelector', 'querySelectorAll', 'closest', 'matches'].includes(method)) {
        // 태그 뒤 `.class` · `#id` · 다른 `[속성]`이 붙어도 태그로 읽는다(④ `span.card[data-url]` · 대문자 `SPAN`).
        for (const m of lower.matchAll(/(?:^|[\s>+~,(])([a-z][a-z0-9]*)?(?:[.#][\w-]+|\[[^\]]*\])*\[(data-[a-z-]+)/g)) {
          out.push({ attr: m[2]!, node: n, tag: m[1] ?? null });
        }
      }
    }
    // x['data-foo'] · dataset['fooBar'] · properties['dataFoo']
    if (ts.isElementAccessExpression(n)) {
      const rawKey = literalText(n.argumentExpression);
      const key = rawKey?.toLowerCase().startsWith('data-') ? rawKey.toLowerCase() : rawKey;
      const owner = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isIdentifier(n.expression) ? n.expression.text : '';
      if (key?.startsWith('data-')) out.push({ attr: key, node: n, tag: null });
      else if (key && owner === 'dataset') out.push({ attr: `data-${kebab(key)}`, node: n, tag: null });
      else if (key && owner === 'properties' && /^data[A-Z]/.test(key)) out.push({ attr: kebab(key), node: n, tag: null });
    }
    // el.dataset.fooBar · node.properties.dataFoo
    if (ts.isPropertyAccessExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const owner = n.expression.name.text;
      const key = n.name.text;
      if (owner === 'dataset') out.push({ attr: `data-${kebab(key)}`, node: n, tag: null });
      if (owner === 'properties' && /^data[A-Z]/.test(key)) out.push({ attr: kebab(key), node: n, tag: null });
    }
    // const { 'data-foo': x } = props
    if (ts.isBindingElement(n) && n.propertyName && ts.isStringLiteral(n.propertyName) && n.propertyName.text.startsWith('data-')) {
      out.push({ attr: n.propertyName.text, node: n, tag: null });
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return out;
}

function readDataAttributes(src: string): Set<string> {
  return new Set(contentAttributeReads(src).map((r) => r.attr));
}

const SAFE_HELPER: Record<'http' | 'data', string> = { http: 'safeHttpUrl', data: 'safeAttachmentDataUrl' };
const SAFE_HELPER_MODULE = /(^|\/)safe-content-url$/;

/** 도우미 이름이 진짜 도우미를 가리키는지(까디르 4705 ③): `lib/safe-content-url`에서 이름 그대로 import했고, 파일 어디에서도 같은
 * 이름을 다시 선언(변수 · 함수 · 매개변수 · 다른 import)하지 않았다. 이름만 보면 `const safeHttpUrl = (x) => x`가 통과한다. */
function genuineHelpers(file: ts.SourceFile): Set<string> {
  const imported = new Set<string>();
  const declared = new Map<string, number>();
  const bump = (name: string) => declared.set(name, (declared.get(name) ?? 0) + 1);
  const visit = (n: ts.Node) => {
    if (ts.isImportSpecifier(n)) {
      bump(n.name.text);
      const decl = n.parent.parent.parent;
      if (!n.propertyName && ts.isStringLiteral(decl.moduleSpecifier) && SAFE_HELPER_MODULE.test(decl.moduleSpecifier.text)) imported.add(n.name.text);
    } else if (ts.isImportClause(n) && n.name) bump(n.name.text);
    else if (ts.isNamespaceImport(n)) bump(n.name.text);
    else if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) bump(n.name.text);
    else if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isClassDeclaration(n)) && n.name) bump(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(file);
  return new Set([...imported].filter((name) => declared.get(name) === 1));
}

/** URL 속성 읽기 중 제 도우미를 안 거치는 것 — 허용: ① 도우미의 첫 인자(`?? ''` · 괄호 · `!` 사이만) ② if 조건 안의 참거짓 확인
 * (`(… ?? '').trim()` 따위 — 값이 싱크로 가지 않음). 그 밖(변수에 담기 · href/src에 넣기 · 다른 함수로 넘기기)은 전부 위반. */
function urlReadsOutsideHelper(src: string): string[] {
  const urlKind = new Map(RENDERER_CONTENT_ATTRIBUTES.filter((e) => e.url).map((e) => [e.attr, e.url!] as const));
  const bad: string[] = [];
  const reads = contentAttributeReads(src);
  const helpers = reads.length ? genuineHelpers(reads[0]!.node.getSourceFile()) : new Set<string>();
  for (const read of reads) {
    const kind = urlKind.get(read.attr);
    if (!kind || read.tag !== null) continue; // 선택자는 값이 아니라 «이 속성이 있는 요소»를 고른다
    let cur: ts.Node = read.node;
    let parent = cur.parent;
    while (parent && (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent)
      || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && parent.left === cur))) {
      cur = parent;
      parent = cur.parent;
    }
    const viaHelper = parent && ts.isCallExpression(parent) && parent.arguments[0] === cur
      && ts.isIdentifier(parent.expression) && parent.expression.text === SAFE_HELPER[kind] && helpers.has(SAFE_HELPER[kind]);
    let inCondition = false;
    for (let a: ts.Node | undefined = read.node; a; a = a.parent) {
      if (ts.isIfStatement(a)) {
        inCondition = a.expression.pos <= read.node.pos && read.node.end <= a.expression.end;
        break;
      }
      // 대입이면 `=`뿐 아니라 `||=` `??=` `&&=` `+=` 따위 전부 — 값이 싱크로 간다(까디르 4705 ②).
      if (ts.isVariableDeclaration(a) || ts.isJsxAttribute(a) || ts.isBinaryExpression(a)
        && a.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && a.operatorToken.kind <= ts.SyntaxKind.LastAssignment) break;
      if (ts.isCallExpression(a) && a !== read.node && !(ts.isPropertyAccessExpression(a.expression) && a.expression.name.text === 'trim')) break;
    }
    if (!viaHelper && !inCondition) {
      const { line } = read.node.getSourceFile().getLineAndCharacterOfPosition(read.node.getStart());
      bad.push(`${read.attr}@${line + 1}`);
    }
  }
  return bad;
}

/** 선택자에 태그를 붙여 콘텐츠 속성을 읽으면 그 태그가 목록의 요소여야 한다(`img[data-url]` 같은 목록 밖 요소 읽기 → 위반). */
function readsOnUnlistedElement(src: string): string[] {
  const elements = new Map(RENDERER_CONTENT_ATTRIBUTES.map((e) => [e.attr, e.elements] as const));
  return contentAttributeReads(src)
    .filter((r) => r.tag !== null && elements.has(r.attr) && !elements.get(r.attr)!.includes(r.tag))
    .map((r) => `${r.tag}[${r.attr}]`);
}

/** 이름이 주소를 담는 속성(`-url` · `-href` · `-src` · `-uri` · `-link` · `-file-data`)은 목록에서 `url` 종류가 필수(까디르 4705 ⑤) —
 * 도우미 강제가 목록의 `url` 옵트인에만 기대면 그 한 줄을 지우는 것만으로 검사 대상에서 빠진다. */
const URL_BEARING_NAME = /-(url|href|src|uri|link|file-data)$/;
function urlAttributesMissingKind(entries: readonly { attr: string; url?: 'http' | 'data' }[]): string[] {
  return entries.filter((e) => URL_BEARING_NAME.test(e.attr) && !e.url).map((e) => e.attr);
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

  it('⭐URL 속성(data-url · data-file-data)은 제 도우미를 거쳐서만 읽힌다 · 목록 밖 요소에서 안 읽힌다(story #4338)', () => {
    expect(urlReadsOutsideHelper(SRC), '도우미 밖 URL 속성 읽기').toEqual([]);
    expect(readsOnUnlistedElement(SRC), '목록 밖 요소에서 콘텐츠 속성 읽기').toEqual([]);
  });

  it('⭐양성 대조(story #4338): 읽는 모양마다 — 겹따옴표 · 템플릿 · dataset · properties · 대괄호 · 구조분해 — 싱크로 가면 RED', () => {
    const sinks: Array<[string, string]> = [
      ['겹따옴표 getAttribute', 'a.href = block.getAttribute("data-url") ?? "";'],
      ['템플릿 getAttribute', 'a.href = block.getAttribute(`data-url`) ?? "";'],
      ['dataset', 'a.href = block.dataset.url ?? "";'],
      ['dataset 대괄호', "iframe.src = block.dataset['url'] ?? '';"],
      ['hast properties', 'return <a href={String(node.properties.dataUrl)} />;'],
      ['hast properties 대괄호', "const u = node.properties['dataFileData']; a.href = String(u);"],
      ['props 대괄호', "return <iframe src={props['data-url']} />;"],
      ['구조분해', "const { 'data-url': u } = props; a.href = u;"],
      ['변수에 담았다가', "const raw = block.getAttribute('data-url') ?? ''; a.href = safeHttpUrl(raw) ?? '';"],
      ['다른 도우미', "a.href = safeAttachmentDataUrl(block.getAttribute('data-url') ?? '') ?? '';"],
    ];
    for (const [label, snippet] of sinks) {
      expect(urlReadsOutsideHelper(`function f(block, node, props, a, iframe) { ${snippet} }`), label).not.toEqual([]);
    }
    // 음성: 제 도우미의 첫 인자 · if 조건 안의 참거짓 확인은 통과.
    const IMPORT = "import { safeAttachmentDataUrl, safeHttpUrl } from './lib/safe-content-url';\n";
    expect(urlReadsOutsideHelper(IMPORT + "function f(block, a) { if (!(block.getAttribute(\"data-url\") ?? '').trim()) return; a.href = safeHttpUrl(block.getAttribute('data-url') ?? '') ?? ''; }")).toEqual([]);
    expect(urlReadsOutsideHelper(IMPORT + "function f(block) { return safeAttachmentDataUrl(block.dataset['fileData'] ?? ''); }")).toEqual([]);
    // 새 속성을 다른 모양으로 읽어도 «목록 밖에서 읽는 속성»에 잡힌다.
    for (const src of ['el.getAttribute("data-new-a")', 'el.dataset.newB', "node.properties['dataNewC']", 'node.properties.dataNewD']) {
      expect(readDataAttributes(src).size, src).toBe(1);
    }
    expect([...readDataAttributes('el.getAttribute("data-new-a"); el.dataset.newB; node.properties.dataNewD')].sort()).toEqual(['data-new-a', 'data-new-b', 'data-new-d']);
    // 목록 밖 요소: data-url은 div에만 — span에서 고르면 RED.
    expect(readsOnUnlistedElement("root.querySelectorAll('span[data-url]')")).toEqual(['span[data-url]']);
    expect(readsOnUnlistedElement("root.querySelectorAll('div[data-url]')")).toEqual([]);
  });

  describe('⭐까디르 4705 빈틈 — 각 모양을 가드가 잡는다(고치기 전 가드는 놓침 · story #4338)', () => {
    const IMPORT = "import { safeAttachmentDataUrl, safeHttpUrl } from './lib/safe-content-url';\n";
    const wrap = (body: string) => `${IMPORT}function f(block, node, props, a, iframe, root, x) { ${body} }`;
    it('① 대문자 속성 이름(DOM은 대소문자 무시) · 계산된 메서드 접근', () => {
      expect(urlReadsOutsideHelper(wrap('a.href = block.getAttribute("DATA-URL") ?? "";')), '대문자').not.toEqual([]);
      expect(urlReadsOutsideHelper(wrap("a.href = block['getAttribute']('data-url') ?? '';")), '계산된 접근').not.toEqual([]);
      expect(readDataAttributes("el['hasAttribute']('Data-New-X')").has('data-new-x')).toBe(true);
    });
    it('② if 조건 면제가 복합 대입(||= ??= &&= +=)으로 새지 않는다', () => {
      for (const op of ['||=', '??=', '&&=', '+=']) {
        expect(urlReadsOutsideHelper(wrap(`if ((a.href ${op} block.getAttribute('data-url') ?? '')) {}`)), op).not.toEqual([]);
      }
    });
    it('③ 도우미는 이름이 아니라 lib/safe-content-url에서 가져온 그것 — 로컬 가림 · import 없음은 위반', () => {
      expect(urlReadsOutsideHelper(wrap("const safeHttpUrl = (v) => v; a.href = safeHttpUrl(block.getAttribute('data-url') ?? '') ?? '';")), '로컬 가림').not.toEqual([]);
      expect(urlReadsOutsideHelper("function f(block, a) { a.href = safeHttpUrl(block.getAttribute('data-url') ?? '') ?? ''; }"), 'import 없음').not.toEqual([]);
      expect(urlReadsOutsideHelper(wrap("a.href = safeHttpUrl(block.getAttribute('data-url') ?? '') ?? '';")), '진짜 도우미는 통과').toEqual([]);
    });
    it('④ 선택자: 클래스 · id가 붙은 태그 · 대문자 태그도 태그로 읽는다', () => {
      expect(readsOnUnlistedElement("root.querySelectorAll('span.card[data-url]')")).toEqual(['span[data-url]']);
      expect(readsOnUnlistedElement("root.querySelectorAll('SPAN[data-url]')")).toEqual(['span[data-url]']);
      expect(readsOnUnlistedElement("root.querySelectorAll('div#x.y[data-url]')")).toEqual([]);
    });
    it('⑤ URL을 담는 이름의 속성에서 `url` 종류를 빼면 RED(옵트인에 기대지 않는다)', () => {
      const stripped = RENDERER_CONTENT_ATTRIBUTES.map((e) => (e.attr === 'data-url' || e.attr === 'data-file-data' ? { ...e, url: undefined } : e));
      expect(urlAttributesMissingKind(stripped)).toEqual(['data-url', 'data-file-data']);
    });
  });

  it('⭐URL을 담는 이름의 콘텐츠 속성은 전부 `url` 종류를 선언한다(도우미 강제의 대상에서 빠지지 않게 · story #4338)', () => {
    expect(urlAttributesMissingKind(RENDERER_CONTENT_ATTRIBUTES)).toEqual([]);
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
