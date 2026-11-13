// @vitest-environment jsdom
//
// 4910 — «첫 저장 때 만들기»의 가장 위험한 자리: 문서가 없던 초안이 만들어져 docId가 생길 때 useDocSync는 «마지막 저장본»을 다시 잡는다.
// 기본(예전) 동작은 «그 틱의 현재 값» — 만드는 요청을 보낸 뒤 응답 오기 전에 친 글자가 «이미 저장됨»으로 보여 조용히 사라진다.
// `adoptBaselineSnapshot`(요청에 실어 보낸 값의 스냅샷)을 넘기면 그 뒤 달라진 만큼이 dirty가 되고 자동저장이 보낸다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useDocSync } from './use-doc-sync';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Payload = { title: string; content: string; content_format: string };
type Opts = Parameters<typeof useDocSync<{ updated_at: string }>>[0];
const out: { current: ReturnType<typeof useDocSync<{ updated_at: string }>> | null } = { current: null };
function Probe({ opts }: { opts: Opts }) { out.current = useDocSync<{ updated_at: string }>(opts); return null; }

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const payload = (content: string): Payload => ({ title: '분기 회고', content, content_format: 'markdown' });
const base = (over: Partial<Opts>): Opts => ({
  docId: null, savePayload: payload(''), serverUpdatedAt: null, editing: true, autosave: true, autosaveDelay: 1500, pollInterval: 600_000,
  ...over,
});
const render = (opts: Opts) => act(async () => { root.render(<Probe opts={opts} />); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const patchCalls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: 'd1', updated_at: '2026-11-13T00:00:02Z' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

// 초안(docId null) → 문서가 만들어짐(docId d1): 보낸 값은 content '안녕', 응답이 오기 전에 사용자가 '안녕하세요'까지 침.
async function createdWhileTyping(adopt: string | null | undefined) {
  await render(base({ savePayload: payload('안녕') }));
  await render(base({ docId: 'd1', serverUpdatedAt: '2026-11-13T00:00:01Z', savePayload: payload('안녕하세요'), adoptBaselineSnapshot: adopt }));
  await tick(5); // 기준선을 다시 잡는 한 틱
}

describe('useDocSync — 문서가 만들어질 때(docId null → id)의 기준선 (4910)', () => {
  it('기본(예전 동작): 기준 = 그 틱의 현재 값 → 생성 중에 친 글자는 dirty가 아니고 자동저장도 안 간다(그래서 이 자리가 위험했다)', async () => {
    await createdWhileTyping(undefined);
    expect(out.current!.isDirty).toBe(false);
    await tick(3000);
    expect(patchCalls()).toHaveLength(0);
  });

  it('⭐adoptBaselineSnapshot = 보낸 값: 생성 중에 친 글자가 dirty가 되고, 자동저장이 PATCH로 최종 내용까지 보낸다', async () => {
    await createdWhileTyping(JSON.stringify(payload('안녕')));
    expect(out.current!.isDirty).toBe(true);
    await tick(1600);
    expect(patchCalls()).toHaveLength(1);
    const [url, init] = patchCalls()[0]!;
    expect(url).toBe('/api/docs/d1');
    expect(JSON.parse((init as RequestInit).body as string).content).toBe('안녕하세요');
  });

  it('보낸 값과 지금 값이 같으면(생성 중에 더 친 것 없음) dirty가 아니다', async () => {
    await render(base({ savePayload: payload('안녕') }));
    await render(base({ docId: 'd1', serverUpdatedAt: '2026-11-13T00:00:01Z', savePayload: payload('안녕'), adoptBaselineSnapshot: JSON.stringify(payload('안녕')) }));
    await tick(5);
    expect(out.current!.isDirty).toBe(false);
    await tick(3000);
    expect(patchCalls()).toHaveLength(0);
  });
});
