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
import type { Editor } from '@tiptap/core';
import { makeDocEditor, partsOf, PARTS_FIXTURE } from './doc-editor-roundtrip.fixture';
import { RENDERER_CONTENT_ATTRIBUTES } from './doc-content-renderer';

/** 렌더러는 안 읽지만 편집기가 저장하고 다시 여는 속성 — 이유와 함께(늘리지 않는 것이 원칙). */
const EDITOR_ONLY_ATTRIBUTES: Record<string, string> = {
  'data-doc-id': '문서 임베드 · 위키 링크의 대상 id — 편집기가 미리보기 · 이동에 쓰고, 렌더러는 slug로 연다',
  'data-mime-type': '첨부 형식 — 편집기 카드 아이콘 · 다운로드 형식 판정',
  'data-cols': '두/세 열 수 — 렌더러 TS는 안 읽고 CSS([data-type="columnsBlock"][data-cols])가 읽는다(마크다운 sanitize 스키마가 dataCols를 통과 · story #4339)',
};

/** 픽스처의 모든 요소에서 `태그|data-속성` 짝. */
function fixtureAttributeSites(html: string): Set<string> {
  const root = document.createElement('div');
  root.innerHTML = html;
  const sites = new Set<string>();
  for (const el of root.querySelectorAll('*')) for (const a of [...el.attributes]) if (a.name.startsWith('data-')) sites.add(`${el.tagName.toLowerCase()}|${a.name}`);
  return sites;
}

function isExplainedSite(site: string): boolean {
  const [tag, attr] = site.split('|') as [string, string];
  if (attr in EDITOR_ONLY_ATTRIBUTES) return true;
  return RENDERER_CONTENT_ATTRIBUTES.some((e) => e.attr === attr && e.elements.includes(tag));
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

  it('⭐가드(렌더러 → 픽스처) — 렌더러가 읽는 콘텐츠 속성(RENDERER_CONTENT_ATTRIBUTES) 전부가 그 속성을 허용한 요소에 실려 이 픽스처에 있다(새 속성을 렌더러에만 더하면 RED)', () => {
    const seen = fixtureAttributeSites(PARTS_FIXTURE);
    const missing = RENDERER_CONTENT_ATTRIBUTES.filter((e) => !e.elements.some((tag) => seen.has(`${tag}|${e.attr}`))).map((e) => e.attr);
    expect(missing).toEqual([]);
  });

  it('⭐가드(픽스처 → 렌더러 · 까디르 4708 ①) — 픽스처의 data-*는 전부 렌더러 목록에 그 요소로 있거나 · 편집기만 쓰는 속성 표에 이유와 함께 있다(목록 밖 속성 · 허용 안 된 요소면 RED)', () => {
    const unexplained = [...fixtureAttributeSites(PARTS_FIXTURE)].filter((site) => !isExplainedSite(site));
    expect(unexplained).toEqual([]);
    // 편집기만 쓰는 표의 항목도 실제로 픽스처에 있다(헛도는 예외 0).
    const seenAttrs = new Set([...fixtureAttributeSites(PARTS_FIXTURE)].map((site) => site.split('|')[1]));
    expect(Object.keys(EDITOR_ONLY_ATTRIBUTES).filter((a) => !seenAttrs.has(a))).toEqual([]);
  });

  it('가드 대조 — 목록 밖 속성 · 목록에 있어도 허용 안 된 요소면 설명되지 않음으로 잡힌다(양성)', () => {
    expect(isExplainedSite('div|data-bogus')).toBe(false);
    expect(isExplainedSite('p|data-url')).toBe(false);
    expect(isExplainedSite('div|data-url')).toBe(true);
  });
});
