// @vitest-environment jsdom
/**
 * story #4370 — 폼 전체(구조 값) 초안 도우미: 닫혔다 열면 그대로 · 서버 값(처음 값)과 같으면 저장 안 함 · 성공/«취소»의 clear ·
 * 깨진 JSON이면 빈 값으로 시작.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fieldDraftStorageKey } from './use-field-draft';
import { reconcileDraft, useJsonFieldDraft } from './use-json-field-draft';

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

// 까디르 P3 — 저장된 값을 모양 검사 없이 캐스팅하던 것: 폼 모양이 바뀐 뒤 남은 옛 초안이 모르는 키 · 다른 타입을 싣고 들어왔다.
describe('useJsonFieldDraft — 옛 모양 초안은 지금 모양에 맞춘다(story #4370 · 까디르 P3)', () => {
  it('모르는 키는 버리고 · 글 칸에 객체가 들어 있으면 처음 값 · 맞는 칸은 살린다', async () => {
    window.sessionStorage.setItem(fieldDraftStorageKey(KEY), JSON.stringify({ title: { 옛: '구조' }, description: '살아남는 설명', legacyNote: '옛 칸' }));
    await mount();
    expect(api.value).toEqual({ title: '서버 제목', description: '살아남는 설명' });
    expect(Object.keys(api.value)).toEqual(['title', 'description']);
  });

  it('객체 자리에 배열 · 원시값이 저장돼 있으면 처음 값', async () => {
    window.sessionStorage.setItem(fieldDraftStorageKey(KEY), JSON.stringify(['옛', '목록']));
    await mount();
    expect(api.value).toEqual(SERVER);
  });
});

describe('reconcileDraft — 모양 맞추기 규칙(story #4370)', () => {
  const ITEM = { mode: 'new', statement: '', metric: null as null | { name: string } };
  it('배열 template: 배열만 받고 항목마다 첫 항목 모양으로 · 객체 아닌 항목은 버림', () => {
    const out = reconcileDraft([{ mode: 'link', statement: '가설', metric: { name: '완료율' }, extra: 1 }, '문자열', null], [ITEM]);
    expect(out).toEqual([{ mode: 'link', statement: '가설', metric: { name: '완료율' } }]);
    expect(reconcileDraft({ not: 'array' }, [ITEM])).toEqual([ITEM]);
  });
  it('null template 자리는 무엇이든 받는다 · 빠진 키는 template 값', () => {
    expect(reconcileDraft({ statement: '문장' }, ITEM)).toEqual({ mode: 'new', statement: '문장', metric: null });
    expect(reconcileDraft({ metric: { name: 'x' } }, ITEM).metric).toEqual({ name: 'x' });
  });
  it('원시값 자리는 원시값만(`number | \'\'` 같은 칸이 있어 원시 타입끼리는 받는다) · 객체 · 배열 · null은 template 값', () => {
    expect(reconcileDraft('글', '')).toBe('글');
    expect(reconcileDraft(40, '')).toBe(40);
    expect(reconcileDraft(true, false)).toBe(true);
    expect(reconcileDraft({ a: 1 }, '')).toBe('');
    expect(reconcileDraft([1], '')).toBe('');
    expect(reconcileDraft(null, '')).toBe('');
  });
});

