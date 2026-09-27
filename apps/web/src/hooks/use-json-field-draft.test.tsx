// @vitest-environment jsdom
/**
 * story #4370 — 폼 전체(구조 값) 초안 도우미: 닫혔다 열면 그대로 · 서버 값(처음 값)과 같으면 저장 안 함 · 성공/«취소»의 clear ·
 * 깨진 JSON이면 빈 값으로 시작.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fieldDraftStorageKey } from './use-field-draft';
import { useJsonFieldDraft } from './use-json-field-draft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Form { title: string; description: string }
const KEY = { surface: 'goal-edit', targetId: 'goal-1', field: 'form' };
const SERVER: Form = { title: '서버 제목', description: '서버 설명' };

let container: HTMLDivElement;
let root: Root;
let api: { value: Form; set: (v: Form) => void; clear: () => void };

function Harness({ initial }: { initial: Form }) {
  const [value, set, clear] = useJsonFieldDraft<Form>(KEY, initial);
  useEffect(() => { api = { value, set, clear }; });
  return null;
}

beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function mount(initial: Form = SERVER) { await act(async () => { root.render(<Harness initial={initial} />); }); }
async function unmount() { await act(async () => { root.render(<></>); }); }
const stored = () => window.sessionStorage.getItem(fieldDraftStorageKey(KEY));

describe('useJsonFieldDraft(story #4370)', () => {
  it('서버 값이 처음 값 · 고치고 닫았다 열면 폼 전체가 그대로', async () => {
    await mount();
    expect(api.value).toEqual(SERVER);
    await act(async () => { api.set({ ...SERVER, description: '고친 설명' }); });
    await unmount();
    await mount();
    expect(api.value).toEqual({ title: '서버 제목', description: '고친 설명' });
  });

  it('서버 값과 같아지면 저장하지 않는다(새 객체여도 값으로 비교)', async () => {
    await mount();
    await act(async () => { api.set({ ...SERVER, description: 'x' }); });
    expect(stored()).not.toBeNull();
    await act(async () => { api.set({ title: '서버 제목', description: '서버 설명' }); });
    expect(stored()).toBeNull();
  });

  it('clear()는 초안을 지우고 서버 값으로', async () => {
    await mount();
    await act(async () => { api.set({ ...SERVER, title: '고친 제목' }); });
    await act(async () => { api.clear(); });
    expect(stored()).toBeNull();
    expect(api.value).toEqual(SERVER);
  });

  it('깨진 JSON이면 빈 값(처음 값)으로 시작', async () => {
    window.sessionStorage.setItem(fieldDraftStorageKey(KEY), '{깨진');
    await mount();
    expect(api.value).toEqual(SERVER);
  });
});
