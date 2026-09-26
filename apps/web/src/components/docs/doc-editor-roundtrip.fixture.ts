/**
 * story #4339 — 문서 편집기 왕복 테스트의 공용 조각(편집기 · 부품 픽스처 · 부품 읽기). 테스트 파일끼리 서로 import하면 가져온 쪽에서 그 파일의
 * 테스트가 한 번 더 등록되므로 여기에 둔다.
 */
import { Editor } from '@tiptap/core';
import { createDocEditorExtensions } from './doc-editor-extensions';

const SLASH_STRINGS = new Proxy({}, { get: () => 'x' }) as never;

export function makeDocEditor(content: string): Editor {
  return new Editor({
    extensions: createDocEditorExtensions({
      placeholder: '',
      projectId: 'p1',
      currentDocId: 'doc-self',
      onNavigate: () => {},
      wikiLinkNotFoundLabel: 'not found',
      storyPickerEmptyLabel: 'empty',
      slashMenuStrings: SLASH_STRINGS,
    }),
    content,
  });
}

/** 라이브 검증 문서(e0aa9f72)의 부품 + 렌더러가 읽는 나머지 부품(수식 · 위키 링크 · 자산 첨부 · 코드 언어). */
export const PARTS_FIXTURE = [
  '<div data-page-embed="" data-doc-id="64c2e43b-4323-4714-b49e-61f0b70fea60" data-title="공유 시각검증 문서" data-icon="📄" data-slug="ortega-visual-share"></div>',
  '<div data-page-embed="" data-doc-id="" data-title="지운 문서 제목(QA)" data-icon="" data-slug="qa-d31-missing-embed-target-4316"></div>',
  '<div data-type="fileAttachment" data-filename="qa-d31-attachment.txt" data-size="40" data-mime-type="text/plain" data-file-data="data:text/plain;base64,UUEgZGVwbG95IDMxIGF0dGFjaG1lbnQgZm9yIHN0b3J5IDQzMjQuCg=="></div>',
  '<div data-type="fileAttachment" data-filename="report.pdf" data-size="2048" data-mime-type="application/pdf" data-asset-id="a1b2c3d4-0000-4000-8000-000000000001"></div>',
  '<div data-type="embedBlock" data-url="https://example.com/"></div>',
  '<div data-type="toggleBlock" data-open="true"><div data-type="toggleSummary"><p>토글 제목</p></div><div data-type="toggleContent"><p>토글 안 내용</p></div></div>',
  '<div data-type="columnsBlock" data-cols="2"><div data-type="columnBlock"><p>왼쪽 단 — <a href="https://example.org/">링크</a></p></div><div data-type="columnBlock"><p>오른쪽 단</p></div></div>',
  '<div data-type="columnsBlock" data-cols="3"><div data-type="columnBlock"><p>하나</p></div><div data-type="columnBlock"><p>둘</p></div><div data-type="columnBlock"><p>셋</p></div></div>',
  '<div data-type="mathBlock" data-latex="E=mc^2"></div>',
  '<p><span data-type="wikiLink" data-doc-id="d0c1d000-0000-4000-8000-000000000002" data-slug="other-doc" data-title="다른 문서">다른 문서</span></p>',
  '<pre data-language="python"><code class="language-python">print(1)</code></pre>',
].join('\n');

type Part = { key: string; attrs: Record<string, string>; text: string };

/** 부품 뿌리(data-type · data-page-embed)마다 data-* 속성과 글. 순서대로. */
export function partsOf(html: string): Part[] {
  const root = document.createElement('div');
  root.innerHTML = html;
  return [...root.querySelectorAll<HTMLElement>('[data-type], [data-page-embed], pre[data-language]')].map((el) => {
    const attrs: Record<string, string> = {};
    for (const a of [...el.attributes]) if (a.name.startsWith('data-')) attrs[a.name] = a.value;
    const key = el.getAttribute('data-type') ?? (el.hasAttribute('data-page-embed') ? 'pageEmbed' : `pre`);
    return { key, attrs, text: (el.textContent ?? '').trim() };
  });
}
