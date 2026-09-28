// @vitest-environment jsdom
/**
 * [SID:4378] 입력칸에 **그 문서 자신**의 slug · id를 넣으면 «서로를 임베드하는 문서라…»(pageEmbedCycle)가 나갔다 — 상황은 «자기 자신»인데
 * «서로를»이라 말함. 자기 자신이면 저장된 자기 임베드 갈래와 같은 «문서는 자기 자신을 임베드할 수 없어요»(pageEmbedSelf) ·
 * 진짜 순환(A↔B)은 지금 문구 그대로. 틀은 page-embed-node.4371.test.tsx와 같다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchMock }));
vi.mock('@tiptap/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tiptap/react')>()),
  NodeViewWrapper: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => <div {...rest}>{children}</div>,
}));

const { PageEmbedView } = await import('./page-embed-node');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const docs = koMessages.docs as unknown as Record<string, string>;
type Attrs = { docId: string | null; title: string | null; icon: string | null; slug: string | null };
const CURRENT = 'doc-current';

let container: HTMLDivElement;
let root: Root;
const updates: Partial<Attrs>[] = [];
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  updates.length = 0;
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const ok = (data: Record<string, unknown>) => ({ ok: true, status: 200, json: async () => ({ data }) });
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

async function mount() {
  function Host() {
    const [attrs, setAttrs] = useState<Attrs>({ docId: null, title: null, icon: null, slug: null });
    const updateAttributes = (next: Partial<Attrs>) => { updates.push(next); setAttrs((a) => ({ ...a, ...next })); };
    const props = { node: { attrs }, updateAttributes, extension: { options: { currentDocId: CURRENT } } } as unknown as Parameters<typeof PageEmbedView>[0];
    return (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <PageEmbedView {...props} />
      </NextIntlClientProvider>
    );
  }
  await act(async () => { root.render(<Host />); });
  await settle();
}
const input = () => container.querySelector<HTMLInputElement>(`input[placeholder="${docs.pageEmbedPlaceholder}"]`);
const alert = () => container.querySelector<HTMLElement>('[role="alert"]');
async function submit(value: string) {
  const el = input()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  await act(async () => { button.focus(); button.click(); });
  await settle();
}

describe('[SID:4378] 입력칸에 자기 문서 — «자기 자신» 문구', () => {
  it.each([
    ['slug', 'current-doc'],
    ['id', CURRENT],
  ])('자기 문서 %s(%s) → «자기 자신» 문구 한 줄(role=alert) · 입력값 유지 · 초점은 입력칸 · 속성 쓰기 0', async (_kind, value) => {
    fetchMock.mockImplementation(async () => ok({ id: CURRENT, title: '지금 문서', icon: null, slug: 'current-doc', embedChain: [] }));
    await mount();
    await submit(value);
    expect(alert()?.textContent).toBe(docs.pageEmbedSelf);
    expect(alert()?.textContent).not.toBe(docs.pageEmbedCycle);
    expect(input()?.value).toBe(value);
    expect(document.activeElement).toBe(input());
    expect(updates).toEqual([]);
  });

  it('진짜 순환(대상의 embedChain에 지금 문서 · A↔B)은 지금 문구 그대로', async () => {
    fetchMock.mockImplementation(async () => ok({ id: 'doc-b', title: 'B', icon: null, slug: 'b', embedChain: [CURRENT] }));
    await mount();
    await submit('b');
    expect(alert()?.textContent).toBe(docs.pageEmbedCycle);
  });
});
