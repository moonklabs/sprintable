// @vitest-environment jsdom
/**
 * story #4339 — HTML 형식 문서를 편집기로 열고(파싱) 다시 직렬화(저장 직전 `getHTML()`)하면 부품 값이 원본과 같아야 한다.
 *
 * 예전: 링크 카드(`embedBlock`)가 `data-url`을 안 읽어(parseHTML 없음) 편집기에선 빈 블록 · 저장하면 URL이 사라졌다(라이브 검증 문서 e0aa9f72).
 * 한 노드씩 덧대지 않게 **부품 전수**로 잰다:
 * - 확장 목록은 편집기와 같은 것(createDocEditorExtensions — 손으로 고른 일부만 쓰면 다른 확장이 부품을 먼저 잡는 결함을 못 본다).
 * - 픽스처는 렌더러가 읽는 콘텐츠 속성(RENDERER_CONTENT_ATTRIBUTES) 전부를 담는다 — 양방향 가드: 목록의 속성이 픽스처에 빠지면 RED.
 * - 판정: 부품(data-type · data-page-embed 뿌리)마다 입력의 data-* 전부가 출력에 같은 값으로 있다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { createDocEditorExtensions } from './doc-editor-extensions';
import { RENDERER_CONTENT_ATTRIBUTES } from './doc-content-renderer';

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

let editor: Editor | null = null;
afterEach(() => { editor?.destroy(); editor = null; });

describe('HTML 문서 → 편집기 → 저장 직렬화 왕복(story #4339)', () => {
  it('⭐부품마다 입력의 data-* 전부가 출력에 같은 값 · 글도 같다(링크 카드 URL · 두 열 · 토글 · 첨부 · 문서 임베드 · 수식 · 위키 링크 · 코드 언어)', () => {
    editor = makeDocEditor(PARTS_FIXTURE);
    const before = partsOf(PARTS_FIXTURE);
    const after = partsOf(editor.getHTML());
    expect(after.map((p) => p.key), '부품 종류 · 순서').toEqual(before.map((p) => p.key));
    const lost: string[] = [];
    before.forEach((b, i) => {
      const a = after[i]!;
      for (const [name, value] of Object.entries(b.attrs)) {
        if (a.attrs[name] !== value) lost.push(`${b.key}#${i} ${name}: ${JSON.stringify(value)} → ${JSON.stringify(a.attrs[name])}`);
      }
      // 글은 «잃지 않음»을 잰다 — 입력에 글이 있으면 그대로. (수식처럼 속성만 싣던 부품은 편집기가 그 값을 글로도 세운다 · 속성 값은 위에서 같다.)
      if (b.text && a.text !== b.text) lost.push(`${b.key}#${i} text: ${JSON.stringify(b.text)} → ${JSON.stringify(a.text)}`);
    });
    expect(lost, lost.join('\n')).toEqual([]);
  });

  it('두 번 왕복해도 같다(열기 → 저장 → 다시 열기 → 저장)', () => {
    editor = makeDocEditor(PARTS_FIXTURE);
    const once = editor.getHTML();
    editor.destroy();
    editor = makeDocEditor(once);
    expect(editor.getHTML()).toBe(once);
  });

  it('⭐양방향 가드 — 렌더러가 읽는 콘텐츠 속성(RENDERER_CONTENT_ATTRIBUTES) 전부가 이 픽스처에 있다(새 속성을 렌더러에만 더하면 RED)', () => {
    const inFixture = new Set(partsOf(PARTS_FIXTURE).flatMap((p) => Object.keys(p.attrs)));
    const root = document.createElement('div');
    root.innerHTML = PARTS_FIXTURE;
    for (const el of root.querySelectorAll('*')) for (const a of [...el.attributes]) if (a.name.startsWith('data-')) inFixture.add(a.name);
    const missing = RENDERER_CONTENT_ATTRIBUTES.map((e) => e.attr).filter((attr) => !inFixture.has(attr));
    expect(missing).toEqual([]);
  });
});
