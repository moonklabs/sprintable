// @vitest-environment jsdom
/**
 * story #4371 — 문서 임베드의 조용한 실패 두 길:
 *  ① 입력칸 제출 실패(찾을 수 없음/불가 · 순환 · 불러오기 실패)가 입력칸 갈래 뒤의 오류 갈래에만 있어 영영 안 그려짐
 *     → 입력칸 아래 오류 한 줄(role="alert") · 입력값 유지 · 초점은 입력칸.
 *  ② 저장된 임베드는 속성으로 채운 상태로 시작해 조회가 안 돎 → 열 때 한 번 조회 · 실패면 오류 · 성공이면 최신 값(같으면 속성 무접촉).
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
const EMPTY: Attrs = { docId: null, title: null, icon: null, slug: null };
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
const status = (code: number) => ({ ok: false, status: code, json: async () => ({}) });
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

async function mount(initial: Attrs) {
  function Host() {
    const [attrs, setAttrs] = useState<Attrs>(initial);
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
  await act(async () => { button.focus(); button.click(); });  // 버튼으로 제출 — 실패하면 초점이 입력칸으로 돌아와야 한다
  await settle();
}

describe('임베드 입력칸 제출 실패 — 입력칸 아래 오류 한 줄(story #4371 AC1 · AC2)', () => {
  it.each([
    ['찾을 수 없음(404)', () => status(404), docs.pageEmbedNotFound],
    ['불가(403)', () => status(403), docs.pageEmbedUnavailable],
    ['순환(대상의 embedChain에 지금 문서)', () => ok({ id: 'doc-b', title: 'B', icon: null, slug: 'b', embedChain: [CURRENT] }), docs.pageEmbedCycle],
    ['불러오기 실패(네트워크)', () => { throw new Error('offline'); }, docs.pageEmbedLoadFailed],
  ])('%s → role=alert 오류 줄 · 입력값 유지 · 초점은 입력칸', async (_label, respond, message) => {
    fetchMock.mockImplementation(async () => respond());
    await mount(EMPTY);
    await submit('missing-doc');
    expect(alert()?.textContent).toBe(message);
    expect(input()!.value).toBe('missing-doc');
    expect(document.activeElement).toBe(input());
    expect(input()!.getAttribute('aria-describedby')).toBe(alert()!.id);
    expect(updates).toEqual([]);
  });

  it('오류 뒤 올바른 slug를 넣으면 오류가 사라지고 임베드된다', async () => {
    fetchMock.mockImplementationOnce(async () => status(404));
    fetchMock.mockImplementation(async () => ok({ id: 'doc-b', title: '기획서', icon: null, slug: 'plan', embedChain: [] }));
    await mount(EMPTY);
    await submit('plna');
    expect(alert()).not.toBeNull();
    await submit('plan');
    expect(alert()).toBeNull();
    expect(container.querySelector('[data-testid="page-embed-preview"]')?.textContent).toContain('기획서');
    expect(fetchMock).toHaveBeenCalledTimes(2);  // 임베드 뒤 같은 대상을 다시 조회하지 않는다
  });
});

describe('저장된 임베드 — 열 때 한 번 조회(story #4371 AC3 · AC5)', () => {
  const SAVED: Attrs = { docId: 'doc-b', title: '옛 제목', icon: '📄', slug: 'plan' };

  it('대상이 지워짐(404) → 옛 제목 카드 대신 «찾을 수 없음» 오류', async () => {
    fetchMock.mockImplementation(async () => status(404));
    await mount(SAVED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="page-embed-error"]')?.textContent).toContain(docs.pageEmbedNotFound);
    expect(container.textContent).not.toContain('옛 제목');
  });

  it('순환 → 순환 오류', async () => {
    fetchMock.mockImplementation(async () => ok({ id: 'doc-b', title: '옛 제목', icon: '📄', slug: 'plan', embedChain: [CURRENT] }));
    await mount(SAVED);
    expect(container.querySelector('[data-testid="page-embed-error"]')?.textContent).toContain(docs.pageEmbedCycle);
  });

  it('제목이 바뀜 → 최신 제목으로 갱신(속성도)', async () => {
    fetchMock.mockImplementation(async () => ok({ id: 'doc-b', title: '새 제목', icon: '📄', slug: 'plan', embedChain: [] }));
    await mount(SAVED);
    expect(container.querySelector('[data-testid="page-embed-preview"]')?.textContent).toContain('새 제목');
    expect(updates).toEqual([{ docId: 'doc-b', title: '새 제목', icon: '📄', slug: 'plan' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('값이 같으면 정상 표시 그대로 · 속성은 건드리지 않는다(열기만으로 문서가 «고침»이 되지 않게) · 조회는 한 번', async () => {
    fetchMock.mockImplementation(async () => ok({ id: 'doc-b', title: '옛 제목', icon: '📄', slug: 'plan', embedChain: [] }));
    await mount(SAVED);
    const card = container.querySelector('[data-testid="page-embed-preview"]')!;
    expect(card.textContent).toContain('옛 제목');
    expect(card.textContent).toContain('📄');
    expect(card.textContent).toContain('/plan');
    expect(updates).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('조회 중에는 자리표시 카드(저장된 속성)를 그린다 — 로딩으로 깜빡이지 않는다', async () => {
    let release: (v: unknown) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((r) => { release = r; }));
    await mount(SAVED);
    expect(container.querySelector('[data-testid="page-embed-preview"]')?.textContent).toContain('옛 제목');
    expect(container.querySelector('[data-testid="page-embed-loading"]')).toBeNull();
    await act(async () => { release(ok({ id: 'doc-b', title: '옛 제목', icon: '📄', slug: 'plan', embedChain: [] })); });
    await settle();
  });
});
