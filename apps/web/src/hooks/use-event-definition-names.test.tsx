// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetEventDefinitionNames, useEventDefinitionNames } from './use-event-definition-names';

// story 4921 — the human name of an event definition by key: ONE shared request for every consumer, a failure is remembered briefly (not asked again by every row), a failed read changes nothing but the wording.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement; let root: Root;
// each probe prints three lookups: a named definition, an empty name, a definition without a name
function Probe() { const name = useEventDefinitionNames(); return <span>{['preset.workflow.kanban', 'preset.x', 'preset.y'].map((k) => name(k) ?? '-').join('/')}</span>; }
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };

beforeEach(() => { resetEventDefinitionNames(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('useEventDefinitionNames (story 4921)', () => {
  it('⭐세 소비처가 요청 하나를 같이 쓰고, 이름이 있는 정의만 담는다(빈 이름 · 이름 없음은 제외)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ([
      { key: 'preset.workflow.kanban', name: ' 칸반 워크플로우 ' }, { key: 'preset.x', name: '' }, { key: 'preset.y' }, { key: 5, name: 'bad' },
    ]) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(<><Probe /><Probe /><Probe /></>); });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('칸반 워크플로우/-/-'.repeat(3)); // trimmed · the empty and the missing name are not kept
  });
  it('⭐읽기 실패(HTTP 오류 · 던짐)는 이름 없음일 뿐이다 — 던지지 않고, 곧바로 다시 묻지도 않는다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => null }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(<Probe />); });
    await settle();
    expect(container.textContent).toBe('-/-/-');
    await act(async () => { root.render(<Probe />); });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1); // remembered for the failure TTL
    resetEventDefinitionNames();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    await act(async () => { root.render(<Probe />); });
    await settle();
    expect(container.textContent).toBe('-/-/-');
  });

  it('⭐조직마다 따로 읽는다 — 조직을 바꾸면 이전 조직의 이름이 새 조직에 보이지 않는다(조직 정의의 이름은 그 조직 것)', async () => {
    const answers: Record<string, string> = { A: '조직 A의 이름', B: '조직 B의 이름' };
    let releaseB!: () => void; const gateB = new Promise<void>((r) => { releaseB = r; });
    let calls = 0;
    const fetchMock = vi.fn(async () => { calls += 1; const org = calls === 1 ? 'A' : 'B'; if (org === 'B') await gateB; return { ok: true, json: async () => ([{ key: 'preset.workflow.kanban', name: answers[org] }]) }; });
    vi.stubGlobal('fetch', fetchMock);
    function OrgProbe({ orgId }: { orgId: string }) { const name = useEventDefinitionNames(orgId); return <span>{name('preset.workflow.kanban') ?? '-'}</span>; }
    await act(async () => { root.render(<OrgProbe orgId="A" />); });
    await settle();
    expect(container.textContent).toBe('조직 A의 이름');
    await act(async () => { root.render(<OrgProbe orgId="B" />); });
    await settle();
    expect(container.textContent).toBe('-'); // B's read is still out: nothing of A's is shown for B
    await act(async () => { releaseB(); });
    await settle();
    expect(container.textContent).toBe('조직 B의 이름');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { root.render(<OrgProbe orgId="A" />); });
    await settle();
    expect(container.textContent).toBe('조직 A의 이름'); // A's own answer is kept (no third read)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
