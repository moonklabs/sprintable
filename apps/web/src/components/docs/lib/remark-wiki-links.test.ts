// story #4313 — 마크다운 위키 링크 remark 플러그인: 실재 문서만 링크 · 없으면 원문 · 코드 · 링크 · raw HTML 안은 무변.
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { remarkWikiLinks } from './remark-wiki-links';

// 적힌 slug → 지금 slug(옛 이름 old-design → design-doc).
const TARGETS: Record<string, string> = { onboarding: 'onboarding', 'design-doc': 'design-doc', 'old-design': 'design-doc' };
const options = { resolve: (s: string) => TARGETS[s] ?? null, href: (s: string) => `/ws/p/docs/${s}` };

type N = { type: string; value?: string; url?: string; children?: N[]; data?: { hProperties?: Record<string, string> } };
function run(md: string): N {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkWikiLinks, options);
  return processor.runSync(processor.parse(md)) as unknown as N;
}
function links(tree: N): N[] {
  const out: N[] = [];
  const visit = (n: N) => { if (n.type === 'link') out.push(n); n.children?.forEach(visit); };
  visit(tree);
  return out;
}
function textOf(tree: N): string {
  let s = '';
  const visit = (n: N) => { if (typeof n.value === 'string') s += n.value; n.children?.forEach(visit); };
  visit(tree);
  return s;
}

describe('remarkWikiLinks(story #4313)', () => {
  it('⭐실재 문서면 링크(url = 문서 주소 · 표지 속성) · «[[slug|글]]»은 글이 보이는 이름', () => {
    const tree = run('앞 [[onboarding]] 가운데 [[design-doc|설계 문서]] 뒤');
    const got = links(tree);
    expect(got.map((l) => l.url)).toEqual(['/ws/p/docs/onboarding', '/ws/p/docs/design-doc']);
    expect(got.map((l) => textOf(l))).toEqual(['onboarding', '설계 문서']);
    expect(got.map((l) => l.data?.hProperties?.dataDocInternalLink)).toEqual(['onboarding', 'design-doc']);
    expect(textOf(tree)).toBe('앞 onboarding 가운데 설계 문서 뒤');
  });

  it('⭐없는 문서는 원문 글자 그대로(깨진 링크 0) — 에이전트 기억 파일 이름 같은 것', () => {
    const tree = run('[[feedback_memory_file]] 과 [[missing|안 보임]] 그리고 [[onboarding]]');
    expect(links(tree).map((l) => l.url)).toEqual(['/ws/p/docs/onboarding']);
    expect(textOf(tree)).toBe('[[feedback_memory_file]] 과 [[missing|안 보임]] 그리고 onboarding');
  });

  it('⭐코드 블록 · 인라인 코드 안은 무변', () => {
    const tree = run('`[[onboarding]]`\n\n```\n[[design-doc]]\n```\n');
    expect(links(tree)).toHaveLength(0);
    expect(textOf(tree)).toContain('[[onboarding]]');
    expect(textOf(tree)).toContain('[[design-doc]]');
  });

  it('기존 링크 글 안(링크 안 링크 0) · raw HTML 블록 안은 무변', () => {
    expect(links(run('[글 [[onboarding]]](https://x.test)')).map((l) => l.url)).toEqual(['https://x.test']);
    // raw HTML 블록은 mdast에서 html 노드 하나(글자 그대로 rehype-raw로 간다). 인라인 태그 사이 글은 보통 마크다운 텍스트라 처리된다.
    const block = run('<div>\n[[design-doc]]\n</div>\n');
    expect(links(block)).toHaveLength(0);
    expect(links(run('앞 <kbd>[[design-doc]]</kbd> 뒤'))).toHaveLength(1);
  });

  it('빈 «[[]]» · 줄바꿈 낀 것 · 공백만인 slug는 링크 아님 · 목록 · 표 안 텍스트도 처리', () => {
    expect(links(run('[[]] [[ ]] [[on\nboarding]]'))).toHaveLength(0);
    expect(links(run('- 항목 [[onboarding]]\n'))).toHaveLength(1);
    expect(links(run('| a |\n|---|\n| [[onboarding]] |\n'))).toHaveLength(1);
  });

  it('⭐옛 이름(alias)으로 적힌 링크 — 주소 · 표지는 지금 slug(alias 해소 왕복 0) · 보이는 글은 적힌 그대로', () => {
    const got = links(run('[[old-design]] · [[old-design|설계]]'));
    expect(got.map((l) => l.url)).toEqual(['/ws/p/docs/design-doc', '/ws/p/docs/design-doc']);
    expect(got.map((l) => l.data?.hProperties?.dataDocInternalLink)).toEqual(['design-doc', 'design-doc']);
    expect(got.map((l) => textOf(l))).toEqual(['old-design', '설계']);
  });

  it('대응이 비면(응답에 wiki_link_targets 없음) 전부 원문', () => {
    const processor = unified().use(remarkParse).use(remarkWikiLinks, { resolve: () => null, href: (s: string) => s });
    const tree = processor.runSync(processor.parse('[[onboarding]] [[design-doc|설계]]')) as unknown as N;
    expect(links(tree)).toHaveLength(0);
    expect(textOf(tree)).toBe('[[onboarding]] [[design-doc|설계]]');
  });
});
