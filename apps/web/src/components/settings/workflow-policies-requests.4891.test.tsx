// @vitest-environment jsdom
//
// story 4891 (UI-8 · «결재 라인 정책» tab) — what each press SENDS is unchanged by the move onto the ds parts. The tab is the line editor (four modes: 보기 · 편집 · 이력 · 변경 비교) plus the read-only active line and
// the dry-run simulator; every request they make goes through two doors (`fetchWithAuth` for the reads, plain `fetch` for the writes), both faked here. The SAME file is green on the old component (origin/develop) and on the new
// one — it finds controls by their words (a button OR a tab, a box by its visible name or its placeholder), never by class or structure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

type Call = { url: string; method: string; body: unknown };
let reads: string[] = [];
let writes: Call[] = [];
let heads: Record<string, unknown> = {}; // the headers each write was sent with, keyed «METHOD url»
const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.settings;
let container: HTMLDivElement;
let root: Root;

const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
const VERSIONS = [
  { id: 'v1', version: 1, status: 'published', lint_status: 'passed', updated_at: '2026-11-01T00:00:00Z', config: { steps: [{ from_status: 'todo', to_status: 'done' }] } },
  { id: 'v2', version: 2, status: 'draft', lint_status: 'pending', updated_at: '2026-11-02T00:00:00Z', config: { steps: [{ from_status: 'todo', to_status: 'doing' }] } },
];
const ACTIVE = { entity_type: 'story', has_active: true, definition_id: 'd1', config: { steps: [{ from_status: 'todo', to_status: 'done' }] } };
let lintAnswer: unknown = { lint_status: 'passed', errors: [] };
let failWrite: string | null = null;

beforeEach(() => {
  reads = []; writes = []; heads = {}; lintAnswer = { lint_status: 'passed', errors: [] }; failWrite = null;
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation(async (input: string) => {
    const url = String(input); reads.push(url);
    if (url.startsWith('/api/workflow-line-config/versions?')) return json(VERSIONS);
    if (url.startsWith('/api/workflow-line-config/active?')) return json(ACTIVE);
    return json(null, 404);
  });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    if (method === 'GET') {
      reads.push(url);
      const m = url.match(/^\/api\/workflow-line-config\/versions\/([\w-]+)$/);
      if (m) return json(VERSIONS.find((v) => v.id === m[1]) ?? { id: m[1], version: 3, status: 'draft', lint_status: 'pending', config: { steps: [{ from_status: 'todo', to_status: 'done' }] } });
      return json(null, 404);
    }
    writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    heads[`${method} ${url}`] = init?.headers;
    if (failWrite && url.includes(failWrite)) return json(null, 500);
    if (url === '/api/workflow-line-config/versions' && method === 'POST') return json({ id: 'v3', version: 3, status: 'draft', lint_status: 'pending', config: { steps: [{ from_status: 'todo', to_status: 'done' }] } }, 201);
    if (url.endsWith('/lint')) return json(lintAnswer);
    if (url.endsWith('/resolve-preview')) return json({ mode: 'enforce', proceeds: true, matched: true, blocking_reason: null, routing_path: [{ from_status: 'todo', to_status: 'merged', route: 'review' }], gates: [{ gate_type: 'human', target: 'po', gate_id: 'g1' }], trust_branch: { trust: 0.82, decision: 'ask_human', cold_start: false } });
    return json({}, 200);
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
async function mount(projectId: string | null = 'p1') {
  const { WorkflowLineEditorSection } = await import('./workflow-line-editor-section');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><WorkflowLineEditorSection projectId={projectId} /></NextIntlClientProvider>); });
  await flush();
}
const PRESSABLE = 'button, [role="tab"]';
/** a press by its visible words (the mode switcher is buttons on the old component, tabs on the new one) */
const press = async (text: string, n = 0) => {
  const hits = ([...container.querySelectorAll(PRESSABLE)] as HTMLElement[]).filter((b) => b.textContent?.trim() === text);
  expect(hits.length, `no press named «${text}»`).toBeGreaterThan(n);
  await act(async () => { hits[n]!.click(); });
  await flush();
};
const pressByAria = async (aria: string) => {
  const b = container.querySelector(`[aria-label="${aria}"]`) as HTMLElement;
  expect(b, `no press labelled «${aria}»`).not.toBeNull();
  await act(async () => { b.click(); });
  await flush();
};
const labelOf = (e: HTMLElement) => ((e as HTMLInputElement).labels?.[0]?.textContent ?? '').trim();
/** a box found by its visible name (new) or the words around it (old: the label wraps the box) or its placeholder */
const box = (name: string) => ([...container.querySelectorAll('input, textarea, select')] as HTMLInputElement[]).find((i) => labelOf(i).includes(name) || i.placeholder === name)!;
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
}
const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement;
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

describe('[SID:4891] 결재 라인 정책: what each press sends is unchanged', () => {
  it('⭐the headers too: the writes with a body say «Content-Type: application/json»; 검사 and 게시 요청 send none at all', async () => {
    await mount('p1');
    await press(T.lineModeEdit);
    await press(T.lineEditorNewDraft);
    await press(T.lineEditorSave);
    await press(T.lineEditorLint);
    await press(T.lineEditorRequestPublish);
    const JSON_HEADER = { 'Content-Type': 'application/json' };
    expect(heads['POST /api/workflow-line-config/versions']).toEqual(JSON_HEADER);
    expect(heads['PATCH /api/workflow-line-config/versions/v3']).toEqual(JSON_HEADER);
    expect('POST /api/workflow-line-config/versions/v3/lint' in heads).toBe(true);
    expect(heads['POST /api/workflow-line-config/versions/v3/lint']).toBeUndefined();
    expect(heads['POST /api/workflow-line-config/versions/v3/request-publish']).toBeUndefined();
    await press(T.lineModeView);
    await type(box(T.simEntityId), 'x'); await type(box(T.simToStatus), 'merged');
    await press(T.simRun);
    expect(heads['POST /api/workflow-line-config/resolve-preview']).toEqual(JSON_HEADER);
  });

  it('opening reads the versions and the active line of the story line for this project', async () => {
    await mount('p1');
    expect(reads).toContain('/api/workflow-line-config/versions?entity_type=story&project_id=p1');
    expect(reads).toContain('/api/workflow-line-config/active?entity_type=story&project_id=p1');
    expect(writes).toEqual([]);
    expect(container.textContent).toContain(T.simActiveLine); // 보기 is the first mode
  });

  it('with no project the reads carry no project_id; choosing another entity type reads that line (versions + active)', async () => {
    await mount(null);
    expect(reads).toContain('/api/workflow-line-config/versions?entity_type=story');
    reads = [];
    await choose(container.querySelector('select') as HTMLSelectElement, 'doc'); // the editor's own entity-type box is the first select
    expect(reads).toContain('/api/workflow-line-config/versions?entity_type=doc');
    expect(reads).toContain('/api/workflow-line-config/active?entity_type=doc');
  });

  it('새 초안 → POST /versions {entity_type, project_id, config: {steps: the active steps}} and then the new draft is opened for editing (GET it)', async () => {
    await mount('p1');
    await press(T.lineModeEdit);
    expect(container.textContent).toContain(T.lineEditorNoDraft);
    await press(T.lineEditorNewDraft);
    expect(writes).toEqual([{ url: '/api/workflow-line-config/versions', method: 'POST', body: { entity_type: 'story', project_id: 'p1', config: { steps: [{ from_status: 'todo', to_status: 'done' }] } } }]);
    expect(reads).toContain('/api/workflow-line-config/versions/v3');
    expect(JSON.parse(textarea().value)).toEqual({ steps: [{ from_status: 'todo', to_status: 'done' }] });
  });

  it('a failed 새 초안 says so (alert) and opens nothing', async () => {
    failWrite = '/versions';
    await mount('p1');
    await press(T.lineModeEdit);
    await press(T.lineEditorNewDraft);
    expect(alertText()).toBe(T.lineEditorCreateError);
    expect(textarea()).toBeNull();
  });

  it('저장 → PATCH /versions/<id> {config: the parsed JSON}; broken JSON sends nothing and says so; a server refusal says so', async () => {
    await mount('p1');
    await press(T.lineModeHistory);
    await pressByAria(T.lineEditorEditAriaLabel.replace('{n}', '2').replace('{label}', T.lineEditorEditAction)); // the draft is the second row
    expect(reads).toContain('/api/workflow-line-config/versions/v2');
    await type(textarea(), '{ not json');
    await press(T.lineEditorSave);
    expect(writes).toEqual([]);
    expect(alertText()).toBe(T.lineEditorJsonError);
    await type(textarea(), '{"steps":[{"from_status":"todo","to_status":"review"}]}');
    await press(T.lineEditorSave);
    expect(writes).toEqual([{ url: '/api/workflow-line-config/versions/v2', method: 'PATCH', body: { config: { steps: [{ from_status: 'todo', to_status: 'review' }] } } }]);
    expect(alertText()).toBeNull();
    writes = []; failWrite = '/versions/v2';
    await press(T.lineEditorSave);
    expect(alertText()).toBe(T.lineEditorSaveError);
  });

  it('검사 → POST /versions/<id>/lint and the answer is shown (pass / fail with the messages)', async () => {
    await mount('p1');
    await press(T.lineModeHistory);
    await pressByAria(T.lineEditorEditAriaLabel.replace('{n}', '2').replace('{label}', T.lineEditorEditAction));
    await press(T.lineEditorLint);
    expect(writes).toEqual([{ url: '/api/workflow-line-config/versions/v2/lint', method: 'POST', body: null }]);
    expect(container.textContent).toContain(T.lineEditorLintPass);
    lintAnswer = { lint_status: 'failed', errors: [{ message: '단계가 비었어요' }] };
    await press(T.lineEditorLint);
    expect(container.textContent).toContain(T.lineEditorLintFail);
    expect(container.textContent).toContain('단계가 비었어요');
  });

  it('게시 요청 → POST /versions/<id>/request-publish (nothing else); a refusal says so', async () => {
    await mount('p1');
    await press(T.lineModeHistory);
    await pressByAria(T.lineEditorEditAriaLabel.replace('{n}', '2').replace('{label}', T.lineEditorEditAction));
    await press(T.lineEditorRequestPublish);
    expect(writes).toEqual([{ url: '/api/workflow-line-config/versions/v2/request-publish', method: 'POST', body: null }]);
    failWrite = '/request-publish';
    await press(T.lineEditorRequestPublish);
    expect(alertText()).toBe(T.lineEditorPublishError);
  });

  it('이력 lists every version with v-number, status and the lint state; only a draft row has 편집 (named «n번째 버전 편집»)', async () => {
    await mount('p1');
    await press(T.lineModeHistory);
    expect(container.textContent).toContain('v1');
    expect(container.textContent).toContain('v2');
    expect(container.textContent).toContain('published');
    expect(container.textContent).toContain('draft');
    expect(container.querySelector(`[aria-label="${T.lineEditorEditAriaLabel.replace('{n}', '2').replace('{label}', T.lineEditorEditAction)}"]`)).not.toBeNull();
    expect(container.querySelector(`[aria-label="${T.lineEditorEditAriaLabel.replace('{n}', '1').replace('{label}', T.lineEditorEditAction)}"]`)).toBeNull(); // the published row has none
    expect(writes).toEqual([]);
  });

  it('변경 비교 shows added / removed / changed steps of the draft against the active line (computed in the page — no request)', async () => {
    await mount('p1');
    await press(T.lineModeHistory);
    await pressByAria(T.lineEditorEditAriaLabel.replace('{n}', '2').replace('{label}', T.lineEditorEditAction));
    writes = [];
    await press(T.lineModeDiff);
    expect(container.textContent).toContain(T.lineEditorDiffHint);
    expect(container.textContent).toContain('todo→doing'); // in the draft only: added
    expect(container.textContent).toContain('todo→done'); // in the active line only: removed
    expect(writes).toEqual([]);
  });

  it('미리보기 (the dry-run) is off until the entity id and the next status are typed; then POST /resolve-preview {entity_type, entity_id (trimmed), from_status (null when empty), to_status (trimmed)} and the three axes are shown', async () => {
    await mount('p1');
    const run = () => ([...container.querySelectorAll('button')] as HTMLButtonElement[]).find((b) => b.textContent?.trim() === T.simRun)!;
    expect(run().disabled).toBe(true);
    await type(box(T.simEntityId), ' 11111111-2222-3333-4444-555555555555 ');
    expect(run().disabled).toBe(true);
    await type(box(T.simToStatus), ' merged ');
    expect(run().disabled).toBe(false);
    await act(async () => { run().click(); });
    await flush();
    expect(writes).toEqual([{ url: '/api/workflow-line-config/resolve-preview', method: 'POST', body: { entity_type: 'story', entity_id: '11111111-2222-3333-4444-555555555555', from_status: null, to_status: 'merged' } }]);
    for (const w of [T.simProceeds, T.simAxisRouting, T.simAxisGates, T.simAxisTrust, T.simDecisionAsk, 'review', 'human · po', '82%']) expect(container.textContent, w).toContain(w);
    // with an «이전 상태» typed it is sent as typed (trimmed)
    writes = [];
    await type(box(T.simFromStatus), ' todo ');
    await act(async () => { run().click(); });
    await flush();
    expect((writes[0]!.body as { from_status: string }).from_status).toBe('todo');
  });

  it('a refused dry-run says so (alert) and shows no result', async () => {
    await mount('p1');
    const run = () => ([...container.querySelectorAll('button')] as HTMLButtonElement[]).find((b) => b.textContent?.trim() === T.simRun)!;
    failWrite = '/resolve-preview';
    await type(box(T.simEntityId), 'x'); await type(box(T.simToStatus), 'merged');
    await act(async () => { run().click(); });
    await flush();
    expect(alertText()).toBe(T.simError);
    expect(container.textContent).not.toContain(T.simAxisRouting);
  });
});
