// @vitest-environment jsdom
/**
 * story #4339(유나 4708 · 수식 빈 칸) — 실 DocEditor(스텁 없음)로 마크다운 문서를 열었을 때 제목 바로 뒤 수식이 비지 않고 · 불러오기만으로
 * 수식을 지운 변경(onChange)이 나가지 않는다.
 *
 * 원인(실 브라우저 · 거래 추적): DocEditor가 편집기 DOM의 h1~h3에 `el.id`를 직접 써서 ProseMirror DOMObserver가 사용자 편집으로 다시
 * 읽었고(readDOMChange), 제목 바로 뒤 수식 NodeView 글이 빈 채로 문서에 들어가 자동 저장이 `data-latex=""`를 냈다. 이제 앵커 id는 HeadingIds
 * 확장(decoration)이 그린다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ ws: 'ws-1', proj: 'proj-b' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/ws-1/proj-b/docs/spec-1',
}));

const { DocEditor } = await import('./doc-editor');
const { makeDocEditor, PARTS_FIXTURE, partsOf } = await import('./doc-editor-roundtrip.fixture');
const { ToastProvider } = await import('../ui/toast');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom엔 배치(layout) API가 없다 — ProseMirror 선택 · 스크롤 계산이 부르는 것만 빈 사각형으로 채운다(이 파일의 관심사는 문서 모델 · DOM 변경).
const EMPTY_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
for (const proto of [Range.prototype, Element.prototype] as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown }[]) {
  proto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  proto.getBoundingClientRect = () => EMPTY_RECT;
}
if (!document.elementFromPoint) (document as { elementFromPoint: () => null }).elementFromPoint = () => null;

/** 유나 A(프로덕션 빌드 GET 본문 그대로) — 제목 바로 뒤 단독 수식 블록. */
const DOC_A = '### 소제목\n\n<div data-type="mathBlock" data-latex="E = mc^2">E = mc^2</div>\n\n끝 문단.';
const LABELS = new Proxy({}, { get: (_t, k) => String(k) }) as never;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function openDoc(md: string, contentFormat: 'markdown' | 'html' = 'markdown') {
  const changes: string[] = [];
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider>
          <DocEditor value={md} contentFormat={contentFormat} onChange={(v) => { changes.push(v); }} labels={LABELS} currentDocId="d1" projectId="p1" />
        </ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return changes;
}

describe('실 DocEditor — 제목 바로 뒤 수식(story #4339 · 유나 A)', () => {
  it('⭐열기만 해도 수식을 지우는 변경이 나가지 않고 · 편집기 수식 글이 산다', async () => {
    const changes = await openDoc(DOC_A);
    for (const c of changes) expect(c, '불러오기로 나간 변경').not.toContain('data-latex=""');
    const editor = (container.querySelector('.ProseMirror') as unknown as { editor?: { getJSON: () => { content?: { type: string; content?: { text?: string }[] }[] } } })?.editor;
    expect(editor, '편집기').toBeDefined();
    const math = (editor!.getJSON().content ?? []).filter((n) => n.type === 'mathBlock');
    expect(math.map((n) => (n.content ?? []).map((c) => c.text ?? '').join(''))).toEqual(['E = mc^2']);
  });

  it('제목 앵커 id는 그대로 선다(목차 이동) — decoration으로', async () => {
    await openDoc(DOC_A);
    expect(container.querySelector('.ProseMirror h3')?.id).toBe('소제목');
  });
});

/**
 * 옛 효과(`el.id` 직접 쓰기)에서 develop(62baf85e1) 실측 — 제목 바로 뒤 세 열 블록이 열기만으로 빈 한 열이 되고, 마크다운 문서의 제목 뒤
 * 단독 수식이 비어 다음 변경에서 통째로 빠졌다(둘 다 onChange로 나가 자동 저장). 나머지 부품은 그대로였다 — 부품 전부를 도는 까닭은
 * 다시 읽기가 어느 NodeView를 비울지 모양마다 달라서.
 */
describe('실 DocEditor — 제목 바로 뒤 × 부품 전부(story #4339 · PO 영향 범위)', () => {
  /** 헤드리스 편집기(DOM 변경 없음)가 같은 HTML에서 읽은 부품이 기준선. */
  function baseline(html: string) {
    const e = makeDocEditor(html);
    try { return partsOf(e.getHTML()); } finally { e.destroy(); }
  }
  /** 픽스처 부품 하나씩 + 글을 품은 수식(유나 A · D의 실패 모양 — 픽스처의 수식은 속성만). */
  const PARTS = [...PARTS_FIXTURE.split('\n'), '<div data-type="mathBlock" data-latex="E = mc^2">E = mc^2</div>'];
  it.each(PARTS.map((part, i) => [`${i + 1}. ${partsOf(part)[0]?.key ?? 'part'}`, part] as const))(
    '⭐%s — 열기만으로 부품 값이 안 바뀌고 · 나간 변경도 기준선과 같다',
    async (_key, part) => {
      const html = `<h2>제목</h2>${part}<p>끝</p>`;
      const expected = baseline(html);
      const changes = await openDoc(html, 'html');
      const editor = (container.querySelector('.ProseMirror') as unknown as { editor: { getHTML: () => string } }).editor;
      expect(partsOf(editor.getHTML()), '편집기 부품').toEqual(expected);
      for (const c of changes) expect(partsOf(c), '불러오기로 나간 변경').toEqual(expected);
    },
  );
});
