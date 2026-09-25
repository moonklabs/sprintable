/**
 * story #4313 — 마크다운 본문의 위키 링크 «[[slug]]» · «[[slug|보이는 글]]»을 문서 링크로.
 *
 * - **실재 문서일 때만** 링크(`exists(slug)` — 문서 상세 응답의 `wiki_link_slugs`). 없으면 원문 글자 그대로(에이전트 기억 파일 이름
 *   같은 «[[…]]»가 «없는 문서»로 가는 깨진 링크가 되지 않게).
 * - 텍스트 노드만 본다 — 코드 블록 · 인라인 코드 · 기존 링크 · raw HTML 안은 건드리지 않는다(mdast에서 각자 다른 노드).
 * - 만든 링크 노드는 hast에 `data-doc-internal-link="{slug}"`를 싣는다(렌더러 `a` 컴포넌트가 클라이언트 이동으로 그린다 · sanitize 스키마가
 *   `a`에 이 속성만 더 허용).
 */

/** 이 플러그인이 다루는 mdast 노드의 최소 모양(`mdast` 타입 패키지를 직접 의존하지 않으려고). */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, string> };
}

export interface RemarkWikiLinksOptions {
  exists: (slug: string) => boolean;
  href: (slug: string) => string;
}

// BE `wiki_link_slug_candidates`(backend/app/routers/docs.py)와 같은 문법: slug 1~200자(대괄호 · 파이프 · 줄바꿈 제외) + 선택 «|글».
const WIKI_LINK_RE = /\[\[([^[\]|\n]{1,200})(?:\|([^[\]\n]*))?\]\]/g;
const SKIP_TYPES = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'html']);

function splitText(value: string, options: RemarkWikiLinksOptions): MdNode[] | null {
  WIKI_LINK_RE.lastIndex = 0;
  const out: MdNode[] = [];
  let last = 0;
  let linked = false;
  for (let m = WIKI_LINK_RE.exec(value); m; m = WIKI_LINK_RE.exec(value)) {
    const slug = m[1]!.trim();
    if (!slug || !options.exists(slug)) continue; // 없는 문서 — 원문 그대로 둔다(아래 나머지 글자에 포함)
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    const label = m[2]?.trim() || slug;
    out.push({
      type: 'link',
      url: options.href(slug),
      children: [{ type: 'text', value: label }],
      data: { hProperties: { dataDocInternalLink: slug } },
    });
    last = m.index + m[0].length;
    linked = true;
  }
  if (!linked) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function walk(node: MdNode, options: RemarkWikiLinksOptions): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && child.value?.includes('[[')) {
      next.push(...(splitText(child.value, options) ?? [child]));
      continue;
    }
    if (!SKIP_TYPES.has(child.type)) walk(child, options);
    next.push(child);
  }
  node.children = next;
}

export function remarkWikiLinks(options: RemarkWikiLinksOptions) {
  return (tree: MdNode) => { walk(tree, options); };
}
