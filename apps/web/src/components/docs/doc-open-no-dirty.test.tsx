// @vitest-environment jsdom
/**
 * story #4339(AC7 · PO 라이브 e0aa9f72) — 편집 없이 연 문서는 저장 표시가 «변경사항 있음»이 되지 않고 자동 저장(PATCH)도 나가지 않는다.
 *
 * 원인 셋(jsdom 판 · 거래 스택 추적):
 * 1. DocEditor가 문서를 바꾸지 않은 거래에도 onChange를 냈다 — `setEditable`(빈 거래)과 BubbleMenu 옵션 갱신(meta만)에 플러그인
 *    appendTransaction(끝 빈 문단 등)이 붙어 정규화된 값이 사용자 편집처럼 나갔다 → dirty → 자동 저장.
 * 2. useDocSync가 문서가 바뀐 뒤 기준선이 잡히기 전 한 틱을 dirty로 쳤다 → 'unsaved' · 자동 저장 예약(기준선 없이 불리면 'error').
 * 3. 'unsaved' 타이머가 dirty가 풀린 뒤에도 실행돼 «status unsaved + isDirty false» 두 세계가 남았다(입력했다가 되돌림도 같은 자리).
 *
 * 순서: 가짜 타이머는 쓰지 않는다 — ProseMirror · tiptap React가 실 타이머 · rAF로 편집기를 붙이므로 가짜 타이머 아래선 편집기가 뜨지
 * 않는다. 대신 «내용 도착 · 편집기 붙음 · 편집 가능 전환»을 act 단계로 나눠 기준선 캡처(setTimeout 0) 앞 · 뒤에 둔다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Editor } from '@tiptap/core';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ ws: 'ws-1', proj: 'proj-b' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/ws-1/proj-b/docs/spec-1',
}));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn(async () => new Response('{}', { status: 404 })) }));

const { DocEditor } = await import('./doc-editor');
const { useDocSync } = await import('./use-doc-sync');
const { makeDocEditor } = await import('./doc-editor-roundtrip.fixture');
const { ToastProvider } = await import('../ui/toast');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom엔 배치(layout) API가 없다 — ProseMirror 선택 · 스크롤 계산이 부르는 것만 빈 사각형으로 채운다.
const EMPTY_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
for (const proto of [Range.prototype, Element.prototype] as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown }[]) {
  proto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  proto.getBoundingClientRect = () => EMPTY_RECT;
}
if (!document.elementFromPoint) (document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;

/** PO 라이브 문서 e0aa9f72 본문 모양 — 블록 사이 줄바꿈 · 토글 제목 `<p>` · target 없는 링크 · 끝이 잎 블록(첨부) = 편집기가 정규화하는 본문. */
const NEEDS_NORMALIZING = [
  '<p>배포 31 문서 부품 검증 문서.</p>',
  '<h2>1. 문서 임베드</h2>',
  '<div data-page-embed="" data-doc-id="64c2e43b-4323-4714-b49e-61f0b70fea60" data-title="공유 시각검증 문서" data-icon="" data-slug="ortega-visual-share"></div>',
  '<h2>4. 링크 카드</h2>',
  '<div data-type="embedBlock" data-url="https://example.com/"></div>',
  '<div data-type="toggleBlock" data-open="true"><div data-type="toggleSummary"><p>토글 제목</p></div><div data-type="toggleContent"><p>토글 안 내용</p></div></div>',
  '<div data-type="columnsBlock" data-cols="2"><div data-type="columnBlock"><p>왼쪽 — <a href="https://example.org/">링크</a></p></div><div data-type="columnBlock"><p>오른쪽</p></div></div>',
  '<div data-type="fileAttachment" data-filename="qa.txt" data-size="40" data-mime-type="text/plain" data-file-data="data:text/plain;base64,UUE="></div>',
  '',
].join('\n');
/** 편집기가 한 번 정규화해 낸 값(= 옛 코드가 열자마자 onChange로 낸 모양). */
const ALREADY_NORMALIZED = (() => {
  const editor = makeDocEditor(NEEDS_NORMALIZING);
  const html = editor.getHTML();
  editor.destroy();
  return html;
})();
const BODIES = [['정규화가 필요한 본문', NEEDS_NORMALIZING], ['이미 정규화된 본문', ALREADY_NORMALIZED]] as const;

const LABELS = new Proxy({}, { get: (_t, k) => String(k) }) as never;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function settle(ms = 200) {
  for (let i = 0; i < ms / 20; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <ToastProvider>{children}</ToastProvider>
    </NextIntlClientProvider>
  );
}

function editorOf(): Editor {
  const dom = container.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
  if (!dom?.editor) throw new Error('편집기가 붙지 않았다');
  return dom.editor;
}

describe('DocEditor — 편집 없이 열면 onChange 0', () => {
  it.each(BODIES)('%s: 열기 · 편집 가능 전환에 onChange가 나가지 않고, 실제 입력은 나간다(양성 대조)', async (_label, body) => {
    const changes: string[] = [];
    const view = (editable: boolean) => (
      <Providers>
        <DocEditor value={body} contentFormat="html" editable={editable} onChange={(v) => { changes.push(v); }} labels={LABELS} currentDocId="d1" projectId="p1" />
      </Providers>
    );
    await act(async () => { root.render(view(false)); });
    await settle();
    await act(async () => { root.render(view(true)); });
    await settle();
    expect(changes).toEqual([]);

    await act(async () => { editorOf().commands.insertContentAt(1, '입력 '); });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('입력 ');
  });
});

type Seen = { status: string; isDirty: boolean };

/** 문서 화면(docs/[slug]/page.tsx)과 같은 엮음 — 실 DocEditor.onChange → content → useDocSync. */
function DocScreen({ doc, content, onContent, editorMounted, seen }: {
  doc: { id: string; updated_at: string } | null;
  content: string;
  onContent: (v: string) => void;
  editorMounted: boolean;
  seen: Seen[];
}) {
  const payload = useMemo(() => ({ title: 'T', content, content_format: 'html' }), [content]);
  const { status, isDirty } = useDocSync({
    docId: doc?.id ?? null, savePayload: payload, serverUpdatedAt: doc?.updated_at ?? null, editing: doc !== null, autosaveDelay: 30,
  });
  seen.push({ status, isDirty });
  return doc && editorMounted
    ? <DocEditor value={content} contentFormat="html" onChange={onContent} labels={LABELS} currentDocId={doc.id} projectId="p1" />
    : null;
}

/**
 * 기준선 캡처(docId가 바뀐 뒤 setTimeout 0)를 기준으로 세 순서:
 * - same-tick: 문서 · 내용 도착과 편집기 붙음이 한 커밋(문서 화면 fetchDoc 그대로).
 * - editor-after-baseline: 기준선이 잡힌 뒤에 편집기가 붙는다(편집기 쪽 정규화가 기준선보다 늦게).
 * - content-before-doc: 내용이 문서 id보다 먼저 도착하고 편집기는 그다음.
 */
const ORDERS = ['same-tick', 'editor-after-baseline', 'content-before-doc'] as const;

describe('문서 화면 엮음 — 열기만으로 dirty · 자동 저장 0', () => {
  it.each(BODIES.flatMap(([label, body]) => ORDERS.map((order) => [label, order, body] as const)))(
    '%s × %s: PATCH 0 · 끝 상태 idle · isDirty false',
    async (_label, order, body) => {
      const writes: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') !== 'GET') writes.push(`${init?.method} ${url}`);
        return new Response(JSON.stringify({ updated_at: '2026-09-26T04:00:00Z' }), { status: 200 });
      }));
      const seen: Seen[] = [];
      const DOC = { id: 'd1', updated_at: '2026-09-26T03:52:31Z' };
      const ctl: { setContent?: (v: string) => void; setState?: (s: { doc: typeof DOC | null; editor: boolean }) => void } = {};
      function Harness() {
        const [content, setContent] = useState('');
        const [state, setState] = useState<{ doc: typeof DOC | null; editor: boolean }>({ doc: null, editor: false });
        useEffect(() => { ctl.setContent = setContent; ctl.setState = setState; }, []);
        return <Providers><DocScreen doc={state.doc} content={content} onContent={setContent} editorMounted={state.editor} seen={seen} /></Providers>;
      }
      await act(async () => { root.render(<Harness />); });
      const setContent = (v: string) => ctl.setContent!(v);
      const setState = (s: { doc: typeof DOC | null; editor: boolean }) => ctl.setState!(s);

      if (order === 'same-tick') {
        await act(async () => { setState({ doc: DOC, editor: true }); setContent(body); });
      } else if (order === 'editor-after-baseline') {
        await act(async () => { setState({ doc: DOC, editor: false }); setContent(body); });
        await settle(60);
        await act(async () => { setState({ doc: DOC, editor: true }); });
      } else {
        await act(async () => { setContent(body); });
        await settle(60);
        await act(async () => { setState({ doc: DOC, editor: false }); });
        await settle(60);
        await act(async () => { setState({ doc: DOC, editor: true }); });
      }
      await settle(400);

      expect(writes).toEqual([]);
      expect(seen.at(-1)).toEqual({ status: 'idle', isDirty: false });
    },
  );
});

describe('useDocSync — unsaved는 dirty일 때만', () => {
  function HookOnly({ content, doc, seen }: { content: string; doc: { id: string; updated_at: string } | null; seen: Seen[] }) {
    const payload = useMemo(() => ({ content }), [content]);
    const { status, isDirty } = useDocSync({
      docId: doc?.id ?? null, savePayload: payload, serverUpdatedAt: doc?.updated_at ?? null, editing: doc !== null, autosaveDelay: 60_000,
    });
    seen.push({ status, isDirty });
    return null;
  }

  it('입력했다가 되돌리면 unsaved가 풀려 dirty 직전 상태(idle)로 돌아간다', async () => {
    const seen: Seen[] = [];
    const DOC = { id: 'd1', updated_at: '2026-09-26T03:52:31Z' };
    await act(async () => { root.render(<HookOnly content="원문" doc={DOC} seen={seen} />); });
    await settle(60);
    await act(async () => { root.render(<HookOnly content="원문 + 입력" doc={DOC} seen={seen} />); });
    await settle(60);
    expect(seen.at(-1)).toEqual({ status: 'unsaved', isDirty: true });
    await act(async () => { root.render(<HookOnly content="원문" doc={DOC} seen={seen} />); });
    await settle(60);
    expect(seen.at(-1)).toEqual({ status: 'idle', isDirty: false });
  });

  it('문서 id와 내용이 같은 틱에 도착해도(기준선은 한 틱 늦게 잡힘) 그 틱을 dirty로 치지 않는다 — unsaved · 자동 저장 예약 0', async () => {
    const seen: Seen[] = [];
    await act(async () => { root.render(<HookOnly content="" doc={null} seen={seen} />); });
    await act(async () => { root.render(<HookOnly content="불러온 본문" doc={{ id: 'd1', updated_at: '2026-09-26T03:52:31Z' }} seen={seen} />); });
    await settle(60);
    expect(seen.filter((s) => s.isDirty || s.status !== 'idle')).toEqual([]);
  });

  it('다른 문서로 옮겨도 옮긴 틱을 dirty로 치지 않고, 옮긴 뒤 입력은 dirty다(양성 대조)', async () => {
    const seen: Seen[] = [];
    await act(async () => { root.render(<HookOnly content="첫 문서" doc={{ id: 'd1', updated_at: 't1' }} seen={seen} />); });
    await settle(60);
    await act(async () => { root.render(<HookOnly content="둘째 문서" doc={{ id: 'd2', updated_at: 't2' }} seen={seen} />); });
    await settle(60);
    expect(seen.filter((s) => s.isDirty || s.status !== 'idle')).toEqual([]);
    await act(async () => { root.render(<HookOnly content="둘째 문서 + 입력" doc={{ id: 'd2', updated_at: 't2' }} seen={seen} />); });
    await settle(60);
    expect(seen.at(-1)).toEqual({ status: 'unsaved', isDirty: true });
  });
});
