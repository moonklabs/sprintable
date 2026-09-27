// @vitest-environment jsdom
/**
 * story #4370 — 공용 초안 훅 단위(AC2 토대): 닫았다 다시 열면 그대로 · 다른 대상 칸엔 안 샘 · 성공 때만 지움 · 빈 칸/서버 값과 같으면 저장 안 함 ·
 * 저장소 실패 무해.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fieldDraftStorageKey, useFieldDraft, type FieldDraftKey } from './use-field-draft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let api: { value: string; set: (v: string) => void; clear: () => void };

function Field({ k, initial }: { k: FieldDraftKey; initial?: string }) {
  const [value, set, clear] = useFieldDraft(k, initial);
  useEffect(() => { api = { value, set, clear }; });
  return <textarea value={value} onChange={(e) => set(e.target.value)} />;
}

beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

const GOAL: FieldDraftKey = { surface: 'goal-create', targetId: null, field: 'description' };
const GATE_A: FieldDraftKey = { surface: 'gate-reject', targetId: 'gate-a', field: 'reason' };
const GATE_B: FieldDraftKey = { surface: 'gate-reject', targetId: 'gate-b', field: 'reason' };

async function mount(k: FieldDraftKey, initial?: string) {
  await act(async () => { root.render(<Field k={k} initial={initial} />); });
}
async function unmountLayer() {
  await act(async () => { root.render(<></>); });  // 창이 닫혀 칸이 언마운트
}

describe('useFieldDraft(story #4370)', () => {
  it('쓰고 닫았다(언마운트) 다시 열면 그대로', async () => {
    await mount(GOAL);
    await act(async () => { api.set('초안 글'); });
    await unmountLayer();
    await mount(GOAL);
    expect(api.value).toBe('초안 글');
    expect(window.sessionStorage.getItem(fieldDraftStorageKey(GOAL))).toBe('초안 글');
  });

  it('다른 대상 칸엔 안 샌다 — 같은 표면 · 칸이라도 대상이 다르면 그 대상의 초안', async () => {
    await mount(GATE_A);
    await act(async () => { api.set('A 사유'); });
    await act(async () => { root.render(<Field k={GATE_B} />); });  // 같은 창을 다른 대상으로(리마운트 없이 키만 바뀜)
    expect(api.value).toBe('');
    await act(async () => { api.set('B 사유'); });
    await act(async () => { root.render(<Field k={GATE_A} />); });
    expect(api.value).toBe('A 사유');
  });

  it('성공 때 clear() → 지움(다시 열면 빈 칸)', async () => {
    await mount(GOAL);
    await act(async () => { api.set('보낼 글'); });
    await act(async () => { api.clear(); });
    expect(window.sessionStorage.getItem(fieldDraftStorageKey(GOAL))).toBeNull();
    await unmountLayer();
    await mount(GOAL);
    expect(api.value).toBe('');
  });

  it('편집 칸: 서버 값(initial)이 처음 값 · 서버 값과 같아지면 저장 안 함 · 다르면 초안이 이긴다', async () => {
    const DESC: FieldDraftKey = { surface: 'story-panel', targetId: 's1', field: 'description' };
    await mount(DESC, '서버 설명');
    expect(api.value).toBe('서버 설명');
    await act(async () => { api.set('서버 설명 + 고침'); });
    await unmountLayer();
    await mount(DESC, '서버 설명');
    expect(api.value).toBe('서버 설명 + 고침');
    await act(async () => { api.set('서버 설명'); });
    expect(window.sessionStorage.getItem(fieldDraftStorageKey(DESC))).toBeNull();
  });

  it('빈 칸은 저장하지 않는다', async () => {
    await mount(GOAL);
    await act(async () => { api.set('x'); });
    await act(async () => { api.set(''); });
    expect(window.sessionStorage.getItem(fieldDraftStorageKey(GOAL))).toBeNull();
  });

  it('초안이 없을 때 서버 값이 바뀌면 따라간다(다른 곳에서 저장됨)', async () => {
    const DESC: FieldDraftKey = { surface: 'story-panel', targetId: 's1', field: 'description' };
    await mount(DESC, 'v1');
    await act(async () => { root.render(<Field k={DESC} initial="v2" />); });
    expect(api.value).toBe('v2');
  });

  it('저장소가 던져도(프라이빗 모드 · 용량) 입력은 된다', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    await mount(GOAL);
    await act(async () => { api.set('그래도 입력'); });
    expect(api.value).toBe('그래도 입력');
  });

  it('키 모양: 표면 · 대상(없으면 new) · 칸', () => {
    expect(fieldDraftStorageKey(GOAL)).toBe('sprintable:field-draft:v1:goal-create:new:description');
    expect(fieldDraftStorageKey(GATE_A)).toBe('sprintable:field-draft:v1:gate-reject:gate-a:reason');
  });
});
