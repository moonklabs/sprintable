// @vitest-environment jsdom
//
// story 4891 (UI-8 · «결재 라인 정책» tab) — what the line editor, the active-line card and the dry-run simulator are made of now, and what a person using a screen reader or a phone gets: the mode switcher is a real tab list
// (one selected, the panel of the selected one only), every box has a name (the entity-type boxes, the JSON box, the four simulator boxes), a failure is an alert that is read again when it repeats, the status tags carry the meaning
// colours (published = done, pending = needs a hand, rejected = failed), and nothing old (`data-slot` outside `ds-*`) is drawn. The requests themselves are pinned in `workflow-policies-requests.4891.test.tsx`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.settings;
let container: HTMLDivElement;
let root: Root;
let failWrite = false;
const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
const VERSIONS = [
  { id: 'v1', version: 1, status: 'published', lint_status: 'passed', config: { steps: [{ from_status: 'todo', to_status: 'done' }] } },
  { id: 'v2', version: 2, status: 'draft', lint_status: 'pending', config: { steps: [{ from_status: 'todo', to_status: 'doing' }] } },
  { id: 'v3', version: 3, status: 'pending_publish', lint_status: 'passed', config: { steps: [] } },
  { id: 'v4', version: 4, status: 'rejected', lint_status: 'failed', config: { steps: [] } },
  { id: 'v5', version: 5, status: 'retired', lint_status: 'passed', config: { steps: [] } },
];

beforeEach(() => {
  failWrite = false;
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation(async (input: string) => {
    const url = String(input);
    if (url.startsWith('/api/workflow-line-config/versions?')) return json(VERSIONS);
    if (url.startsWith('/api/workflow-line-config/active?')) return json({ entity_type: 'story', has_active: true, config: { steps: [{ from_status: 'todo', to_status: 'done' }] } });
    return json(null, 404);
  });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    if (method === 'GET') { const m = url.match(/versions\/([\w-]+)$/); return m ? json(VERSIONS.find((v) => v.id === m[1])) : json(null, 404); }
    if (failWrite) return json(null, 500);
    if (url === '/api/workflow-line-config/versions' && method === 'POST') return json(VERSIONS[1], 201);
    if (url.endsWith('/lint')) return json({ lint_status: 'failed', errors: [{ message: '단계가 비었어요' }] });
    if (url.endsWith('/resolve-preview')) return json({ mode: 'enforce', proceeds: false, matched: false, blocking_reason: '정책에 막혔어요', routing_path: [{ from_status: null, to_status: 'merged', route: 'review' }], gates: [{ gate_type: 'policy', target: 'po', gate_id: 'g1' }, { gate_type: 'merge', target: null, gate_id: null }], trust_branch: { trust: null, decision: 'block', cold_start: true } });
    return json({}, 200);
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
async function mount() {
  const { WorkflowLineEditorSection } = await import('./workflow-line-editor-section');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><WorkflowLineEditorSection projectId="p1" /></NextIntlClientProvider>); });
  await flush();
}
const tab = (text: string) => ([...container.querySelectorAll('[role="tab"]')] as HTMLElement[]).find((b) => b.textContent?.trim() === text)!;
const btn = (text: string) => ([...container.querySelectorAll('button')] as HTMLButtonElement[]).find((b) => b.textContent?.trim() === text)!;
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); await flush(); };
const oldSlots = () => [...container.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-'));
const nameOf = (e: HTMLElement) => e.getAttribute('aria-label') ?? (e as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? '';
async function type(el: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('[SID:4891] 결재 라인 정책 on ds parts', () => {
  it('⭐the mode switcher is a tab list named by the tab’s title: four tabs, 보기 selected, only the selected one’s panel is drawn; choosing another moves the selection and the panel', async () => {
    await mount();
    const list = container.querySelector('[role="tablist"]') as HTMLElement;
    expect(list.getAttribute('aria-label')).toBe(T.tabWorkflowPolicies);
    const names = [...list.querySelectorAll('[role="tab"]')].map((b) => b.textContent?.trim());
    expect(names).toEqual([T.lineModeView, T.lineModeEdit, T.lineModeHistory, T.lineModeDiff]);
    expect(tab(T.lineModeView).getAttribute('aria-selected')).toBe('true');
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
    expect(container.textContent).toContain(T.simActiveLine);
    await click(tab(T.lineModeHistory));
    expect(tab(T.lineModeView).getAttribute('aria-selected')).toBe('false');
    expect(tab(T.lineModeHistory).getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).not.toContain(T.simActiveLine);
    expect(container.textContent).toContain('v2');
  });

  it('⭐every box has a name: the editor’s entity-type box, the active-line card’s box, the four simulator boxes; in the edit mode the JSON box too', async () => {
    await mount();
    const boxes = [...container.querySelectorAll('input, select, textarea')] as HTMLElement[];
    expect(boxes.length).toBe(6); // 2 selects (editor · active card) + simulator (select · 3 inputs)
    expect(boxes.every((b) => nameOf(b) !== ''), `unnamed: ${boxes.filter((b) => nameOf(b) === '').length}`).toBe(true);
    expect(boxes.map(nameOf)).toEqual([T.simEntityType, T.simActiveLine, T.simEntityType, T.simEntityId, T.simFromStatus, T.simToStatus]);
    await click(tab(T.lineModeEdit));
    await click(btn(T.lineEditorNewDraft));
    expect(nameOf(container.querySelector('textarea')!)).toBe(T.lineModeEdit);
  });

  it('draws no old ui/ part in any mode (data-slot): tabs, selects, boxes, buttons, tags are ds', async () => {
    await mount();
    const seen = new Set<string>();
    for (const m of [T.lineModeView, T.lineModeEdit, T.lineModeHistory, T.lineModeDiff]) {
      await click(tab(m));
      if (m === T.lineModeEdit) await click(btn(T.lineEditorNewDraft));
      for (const s of [...container.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!)) seen.add(s);
      expect(oldSlots(), `mode ${m}`).toEqual([]);
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('the history’s status tags carry the meaning: published = done, pending_publish = needs a hand, rejected = failed, draft/retired = neutral (colour is never the only sign: the status word is the tag’s text)', async () => {
    await mount();
    await click(tab(T.lineModeHistory));
    const tagFor = (word: string) => ([...container.querySelectorAll('li span')] as HTMLElement[]).find((s) => s.textContent?.trim() === word && s.className.includes('rounded-ds-tag'))!;
    expect(tagFor('published').className).toContain('bg-ds-done-soft');
    expect(tagFor('pending_publish').className).toContain('bg-ds-needs-hand-soft');
    expect(tagFor('rejected').className).toContain('bg-ds-failed-soft');
    expect(tagFor('draft').className).toContain('bg-ds-surface-high');
    expect(tagFor('retired').className).toContain('bg-ds-surface-high');
  });

  it('변경 비교: a step only in the draft is «+» on the done tone, one only in the active line is «−» on the failed tone (the sign is the text — the colour is never alone)', async () => {
    await mount();
    await click(tab(T.lineModeHistory));
    await click(container.querySelector(`[aria-label="${T.lineEditorEditAriaLabel.replace('{n}', '2').replace('{label}', T.lineEditorEditAction)}"]`) as HTMLElement);
    await click(tab(T.lineModeDiff));
    const row = (key: string) => ([...container.querySelectorAll('li')] as HTMLElement[]).find((li) => li.textContent?.includes(key))!;
    const signTag = (key: string) => row(key).querySelector('span.rounded-ds-tag') as HTMLElement;
    expect(signTag('todo→doing').textContent?.trim()).toBe('+');
    expect(signTag('todo→doing').className).toContain('bg-ds-done-soft');
    expect(signTag('todo→done').textContent?.trim()).toBe('−');
    expect(signTag('todo→done').className).toContain('bg-ds-failed-soft');
  });

  it('a failed press is an alert (ds failed Banner) that is read again when the same failure repeats (a new node each time)', async () => {
    await mount();
    await click(tab(T.lineModeEdit));
    failWrite = true;
    await click(btn(T.lineEditorNewDraft));
    const first = container.querySelector('[role="alert"]') as HTMLElement;
    expect(first.textContent).toContain(T.lineEditorCreateError);
    expect(first.getAttribute('data-slot')).toBe('ds-banner');
    await click(btn(T.lineEditorNewDraft));
    const second = container.querySelector('[role="alert"]') as HTMLElement;
    expect(second.textContent).toContain(T.lineEditorCreateError);
    expect(second).not.toBe(first);
  });

  it('⭐the SAME failure twice with no reading in between (broken JSON saved twice — nothing is awaited, so no render comes between) is still a NEW alert node: the nonce key is what makes the second one read out', async () => {
    await mount();
    await click(tab(T.lineModeHistory));
    await click(container.querySelector(`[aria-label="${T.lineEditorEditAriaLabel.replace('{n}', '2').replace('{label}', T.lineEditorEditAction)}"]`) as HTMLElement);
    const box = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, '{ not json'); box.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(btn(T.lineEditorSave));
    const first = container.querySelector('[role="alert"]') as HTMLElement;
    expect(first.textContent).toContain(T.lineEditorJsonError);
    await click(btn(T.lineEditorSave));
    const second = container.querySelector('[role="alert"]') as HTMLElement;
    expect(second.textContent).toContain(T.lineEditorJsonError);
    expect(second).not.toBe(first);
  });

  it('the lint answer: a failure shows the failed tag and each message; the save button is the one primary button of the edit mode', async () => {
    await mount();
    await click(tab(T.lineModeHistory));
    await click(container.querySelector(`[aria-label="${T.lineEditorEditAriaLabel.replace('{n}', '2').replace('{label}', T.lineEditorEditAction)}"]`) as HTMLElement);
    await click(btn(T.lineEditorLint));
    expect(container.textContent).toContain(T.lineEditorLintFail);
    expect(container.textContent).toContain('단계가 비었어요');
    const primaries = ([...container.querySelectorAll('button')] as HTMLElement[]).filter((b) => b.className.includes('bg-ds-action'));
    expect(primaries.map((b) => b.textContent?.trim())).toEqual([T.lineEditorSave]);
  });

  it('the dry-run result: blocked tag, the unmatched/blocking-reason lines, the route tag, the gate tags by kind (policy = failed, merge = action) and the decision tag (block = failed); no trust = «데이터 없음» + cold start', async () => {
    await mount();
    await type(container.querySelector('input[placeholder="uuid"]') as HTMLInputElement, 'x');
    await type(container.querySelector('input[placeholder="merged"]') as HTMLInputElement, 'merged');
    await click(btn(T.simRun));
    const text = container.textContent ?? '';
    for (const w of [T.simBlocked, T.simUngoverned, '정책에 막혔어요', 'review', 'policy · po', 'merge', T.simDecisionBlock, T.simTrustNull, T.simColdStart]) expect(text, w).toContain(w);
    const tagsOf = (word: string) => ([...container.querySelectorAll('span')] as HTMLElement[]).filter((s) => s.textContent?.trim() === word && s.className.includes('rounded-ds-tag'));
    // «차단» is both the result tag (blocked) and the decision tag (block): two tags, both failed
    expect(T.simBlocked).toBe(T.simDecisionBlock);
    expect(tagsOf(T.simBlocked)).toHaveLength(2);
    expect(tagsOf(T.simBlocked).every((t) => t.className.includes('bg-ds-failed-soft'))).toBe(true);
    expect(tagsOf('policy · po')).toHaveLength(1);
    expect(tagsOf('policy · po')[0]!.className).toContain('bg-ds-failed-soft');
    expect(tagsOf('merge')).toHaveLength(1);
    expect(tagsOf('merge')[0]!.className).toContain('bg-ds-action-soft');
  });
});
