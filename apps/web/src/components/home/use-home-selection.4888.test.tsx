// @vitest-environment jsdom
// story #4888(UI-5 홈) — 고른 행이 목록에서 사라지면 «그 구역 안의» 다음 행이 선택된다(승인이면 다음 승인 · 끝난 일이면 다음 끝난 일). 구역 밖(손 필요 첫 행)으로 튀지 않는다.
import { afterEach, describe, expect, it } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useHomeSelection } from './use-home-selection';
import type { HomeModel, HomeRow } from './derive-home';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => { await act(async () => { root?.unmount(); }); root = null; document.body.innerHTML = ''; });

const r = (key: string, section: HomeRow['section']): HomeRow => ({ key, section, kind: section === 'needs-hand' ? 'approval' : section === 'working' ? 'agent-run' : 'done', title: key, actor: null, since: '2026-11-11T09:00:00Z', ref: { type: 'gate', id: key, projectId: null } });
const model = (needs: string[], working: string[], done: string[]): HomeModel => {
  const needsHand = needs.map((k) => r(k, 'needs-hand'));
  return { badge: needsHand.length, header: { needsHand: needsHand.length, working: working.length, justDone: done.length }, needsHand, working: working.map((k) => r(k, 'working')), justDone: done.map((k) => r(k, 'just-done')), needsHandVisible: needsHand, needsHandHidden: 0, initialSelection: needsHand[0]?.key ?? null };
};
let api: ReturnType<typeof useHomeSelection>;
function Probe({ m }: { m: HomeModel }) {
  const a = useHomeSelection(m);
  useEffect(() => { api = a; });   // 바깥에서 select를 부르려고 — 렌더 중에 대입하지 않는다
  return <span data-testid="k">{a.selectedKey ?? 'none'}</span>;
}
const key = () => document.body.querySelector('[data-testid="k"]')!.textContent;
async function show(m: HomeModel) {
  if (!root) { const el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); }
  await act(async () => { root!.render(<Probe m={m} />); });
}

describe('useHomeSelection', () => {
  it('⭐처음에는 첫 «손 필요» 행', async () => {
    await show(model(['a', 'b'], ['w1'], ['d1']));
    expect(key()).toBe('a');
  });
  it('⭐«일하는 중» 행을 골랐다가 그 행이 사라지면 같은 구역의 다음 행이 선택된다(손 필요 첫 행으로 튀지 않는다)', async () => {
    await show(model(['a', 'b'], ['w1', 'w2', 'w3'], []));
    await act(async () => { api.select('w2'); });
    expect(key()).toBe('w2');
    await show(model(['a', 'b'], ['w1', 'w3'], []));      // w2 사라짐 → 그 자리의 w3
    expect(key()).toBe('w3');
  });
  it('⭐«방금 끝남» 행이 마지막인데 사라지면 같은 구역의 앞 행 · 구역이 비면 첫 «손 필요» 행', async () => {
    await show(model(['a'], [], ['d1', 'd2']));
    await act(async () => { api.select('d2'); });
    await show(model(['a'], [], ['d1']));
    expect(key()).toBe('d1');
    await show(model(['a'], [], []));
    expect(key()).toBe('a');
  });
  it('⭐«손 필요» 행이 사라지면 그 자리의 다음 행(전과 같다)', async () => {
    await show(model(['a', 'b', 'c'], [], []));
    await act(async () => { api.select('b'); });
    await show(model(['a', 'c'], [], []));
    expect(key()).toBe('c');
  });
  it('고른 행이 그대로 있으면 옮겨 가지 않는다', async () => {
    await show(model(['a', 'b'], ['w1'], []));
    await act(async () => { api.select('w1'); });
    await show(model(['b'], ['w1'], []));
    expect(key()).toBe('w1');
  });
});
