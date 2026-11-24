// @vitest-environment jsdom
//
// story 4977 (B3-2b) — the «기록» sheet: the history of one chat as the phone's shell opened it. Opens at the END (the newest line), [더 불러오기] above shows earlier lines, a row the shell could not open is only counted,
// no key says «cannot open yet» (never «nothing was kept»), a refusal has its sentence in ko AND en, a late answer of a closed sheet is not drawn, the delete asks once and says what goes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const SETUP = '11111111-2222-4333-8444-555555555555';
const ROOM = '22222222-3333-4444-8555-666666666666';
const PHONE = '33333333-4444-4555-8666-777777777777';
const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const phoneCall = vi.fn();
let inPhoneApp = true;
vi.mock('@/components/providers/phone-bridge-context', () => ({ usePhoneBridge: () => ({ inPhoneApp, phoneCall: (...a: unknown[]) => phoneCall(...a) }) }));
const readStartableKeyed = vi.fn();
vi.mock('@/lib/phone-start', () => ({ readStartableKeyed: (...a: unknown[]) => readStartableKeyed(...a) }));
let zone: string | null = 'Asia/Seoul';
vi.mock('@/components/viewer-time-zone', () => ({ useViewerTimeZone: () => zone }));
const takeHandoffs = vi.fn();
vi.mock('@/lib/phone-handoff', () => ({ takeHandoffs: (...a: unknown[]) => takeHandoffs(...a) }));
const startHandoffWatch = vi.fn();
vi.mock('@/lib/phone-handoff-watch', () => ({ ON_OPEN_MS: 60_000, startHandoffWatch: (...a: unknown[]) => startHandoffWatch(...a) }));
const NO_LOOK = { kind: 'unreachable' } as const; // (the default of the older tests: the look did not complete, so no second read)
const NOTHING_TAKEN = { kind: 'done', seen: 0, taken: 0, later: 0, rejected: 0, acked: 0 } as const;
const TOOK_ONE = { kind: 'done', seen: 1, taken: 1, later: 0, rejected: 0, acked: 1 } as const;
const { AgentRecordsSheet } = await import('./agent-records-sheet');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const row = (seq: number) => ({ id: `r${seq}`, seq, record_id: `rec-${seq}`, kind: 'chat_line', rec_gen: 1, created_at: 'x', envelope: { sealed: 'SEALED-WORDS' } });
const line = (seq: number, text: string, over: Record<string, unknown> = {}) => ({ seq, record_id: `rec-${seq}`, kind: 'chat_line', rec_gen: 1, state: 'open', writer: 'phone', ts: 1_790_000_000_000 + seq * 1000, frame: { conversation_id: ROOM, text, v: 1 }, ...over });
const closedLine = (seq: number, state: string) => ({ seq, record_id: `rec-${seq}`, kind: 'chat_line', rec_gen: 1, state });
const shellAnswer = (lines: unknown[], over: Record<string, unknown> = {}) => ({ id: 'c', ok: true, have_key: true, lines, next_after: 0, ...over });
const ko = koMessages.chats.agentSession.records;
const en = enMessages.chats.agentSession.records;

let container: HTMLDivElement;
let root: Root;
const scrollHeight = 777;
beforeEach(() => {
  zone = 'Asia/Seoul';
  inPhoneApp = true; takeHandoffs.mockReset().mockResolvedValue(NO_LOOK); startHandoffWatch.mockReset();
  fetchWithAuth.mockReset(); phoneCall.mockReset(); readStartableKeyed.mockReset().mockResolvedValue({ kind: 'view', view: {}, phoneKeyId: PHONE });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; });

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); }); };
async function show(isOpen = true, locale: 'ko' | 'en' = 'ko', where: { room?: string; setup?: string | null; agent?: string; device?: string | null } = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentRecordsSheet conversationId={where.room ?? ROOM} setupId={where.setup === undefined ? SETUP : where.setup} {...(where.agent ? { agentId: where.agent } : {})} {...(where.device !== undefined ? { deviceName: where.device } : {})} open={isOpen} onOpenChange={() => {}} />
      </NextIntlClientProvider>,
    );
  });
  await settle();
}
/** the server's page + the shell's answer for it */
function history(lines: unknown[], over: Record<string, unknown> = {}, rows = lines.map((_, i) => row(i + 1))) {
  fetchWithAuth.mockResolvedValueOnce(json(200, { records: rows, next_after: rows.length }));
  phoneCall.mockResolvedValueOnce(shellAnswer(lines, { next_after: rows.length, ...over }));
}
const q = (sel: string) => document.body.querySelector(sel);
const all = (sel: string) => [...document.body.querySelectorAll(sel)];
const text = () => all('[data-testid="agent-records-line"]').map((e) => e.querySelector('p')!.textContent);
const click = async (sel: string) => { await act(async () => { (q(sel) as HTMLButtonElement).click(); }); await settle(); };

describe('the «기록» sheet', () => {
  it('shows what the shell opened, oldest first by the writers\' own time, opens at the END, and shows no envelope', async () => {
    history([line(2, 'second', { ts: 2_000_000_000_000 }), line(1, 'first', { ts: 1_000_000_000_000 }), { ...line(3, 'x'), kind: 'approval_record', ts: 2_500_000_000_000, writer: 'host', frame: { conversation_id: ROOM, decision: 'allow', request_id: ROOM, summary: 'npm install', tool: 'Bash', v: 1 } }]);
    await show();
    expect(q('h2')!.textContent).toBe(ko.title);
    expect(document.body.textContent).toContain(ko.lead);
    expect(all('[data-testid="agent-records-line"]').map((e) => e.getAttribute('data-kind'))).toEqual(['chat_line', 'chat_line', 'approval_record']);
    expect(text()).toEqual(['first', 'second', ko.allowed.replace('{tool}', 'Bash')]);
    expect(all('[data-testid="agent-records-line"]')[2]!.textContent).toContain('npm install');
    expect(all('[data-testid="agent-records-line"]')[0]!.textContent).toContain(`${ko.instruction} · ${ko.writerPhone}`);
    expect(all('[data-testid="agent-records-line"]')[2]!.textContent).toContain(ko.writerHost);
    expect((q('[data-testid="agent-records-list"]') as HTMLElement).scrollTop).toBe(scrollHeight); // the end of the list
    expect(document.body.textContent).not.toContain('SEALED-WORDS');
    const [url] = fetchWithAuth.mock.calls[0] as [string];
    expect(url).toContain(`/api/desktop/computers/${SETUP}/records?`); expect(url).toContain(`phone_key_id=${PHONE}`); expect(url).toContain(`conversation_id=${ROOM}`);
  });

  it('a person\'s words are drawn as text, never as markup', async () => {
    history([line(1, '<img src=x onerror=alert(1)> <b>bold</b>')]);
    await show();
    expect(q('[data-testid="agent-records-line"] img')).toBeNull();
    expect(text()).toEqual(['<img src=x onerror=alert(1)> <b>bold</b>']);
  });

  it('thirty lines first (the newest), [더 불러오기] above shows thirty earlier ones', async () => {
    const lines = Array.from({ length: 70 }, (_, i) => line(i + 1, `line ${i + 1}`));
    history(lines);
    await show();
    expect(text()).toHaveLength(30);
    expect(text()[0]).toBe('line 41'); expect(text()[29]).toBe('line 70');
    expect((q('[data-testid="agent-records-earlier"]') as HTMLElement).textContent).toBe(ko.loadMore);
    await click('[data-testid="agent-records-earlier"]');
    expect(text()).toHaveLength(60); expect(text()[0]).toBe('line 11');
    await click('[data-testid="agent-records-earlier"]');
    expect(text()).toHaveLength(70);
    expect(q('[data-testid="agent-records-earlier"]')).toBeNull(); // nothing earlier is left
  });

  it('nothing kept: one line, and no delete button', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: [], next_after: 0 }));
    await show();
    expect(q('[data-testid="agent-records-empty"]')!.textContent).toBe(ko.empty);
    expect(q('[data-testid="agent-records-delete"]')).toBeNull();
    expect(phoneCall).not.toHaveBeenCalled();
  });

  it('a phone with no key: «cannot open it yet» — never «nothing was kept» — and the rows are not counted twice', async () => {
    history([closedLine(1, 'no_key'), closedLine(2, 'no_key')], { have_key: false });
    await show();
    expect(q('[data-testid="agent-records-keyless"]')!.textContent).toBe(ko.keyless);
    expect(q('[data-testid="agent-records-empty"]')).toBeNull();
    expect(q('[data-testid="agent-records-nokey"]')).toBeNull();
  });

  it('what the shell could not open is only counted, one line per reason (ko and en plural)', async () => {
    const rows = [...Array.from({ length: 3 }, (_, i) => closedLine(i + 1, 'no_key')), closedLine(4, 'unverified'), closedLine(5, 'unreadable'), closedLine(6, 'unreadable'), line(7, 'shown')];
    history(rows);
    await show();
    expect(q('[data-testid="agent-records-nokey"]')!.textContent).toBe(ko.noKey.replace('{n}', '3'));
    expect(q('[data-testid="agent-records-unverified"]')!.textContent).toBe(ko.unverified.replace('{n}', '1'));
    expect(q('[data-testid="agent-records-unreadable"]')!.textContent).toBe(ko.unreadable.replace('{n}', '2'));
    expect(text()).toEqual(['shown']);
    await show(false);
    history(rows);
    await show(true, 'en');
    expect(q('[data-testid="agent-records-nokey"]')!.textContent).toBe('3 entries can\'t be opened on this phone');
    expect(q('[data-testid="agent-records-unverified"]')!.textContent).toBe('1 entry from an unverified sender');
    expect(q('[data-testid="agent-records-unreadable"]')!.textContent).toBe('2 entries can\'t be read');
    expect(en.problem.failed).toContain('Reload');
  });

  it('a refusal has its sentence; only a load that can be tried again has [다시 불러오기], and pressing it reads again', async () => {
    const cases: Array<[() => void, string, boolean]> = [
      [() => fetchWithAuth.mockResolvedValueOnce(json(409, { error: { code: 'phone_not_paired' } })), ko.problem.notPaired, false],
      [() => fetchWithAuth.mockResolvedValueOnce(json(403, {})), ko.problem.notAllowed, false],
      [() => fetchWithAuth.mockResolvedValueOnce(json(404, { error: { code: 'record_conversation_not_found' } })), ko.problem.notAllowed, false],
      [() => { fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1)], next_after: 1 })); phoneCall.mockResolvedValueOnce({ id: 'c', ok: false, code: 'bad_request' }); }, ko.problem.unsupported, false],
      [() => fetchWithAuth.mockResolvedValueOnce(json(500, {})), ko.problem.failed, true],
      [() => fetchWithAuth.mockRejectedValueOnce(new Error('net')), ko.problem.failed, true],
      [() => { fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1)], next_after: 1 })); phoneCall.mockResolvedValueOnce({ id: 'c', ok: false, code: 'record_keys_unavailable' }); }, ko.problem.failed, true],
    ];
    for (const [arrange, sentence, retry] of cases) {
      fetchWithAuth.mockReset(); phoneCall.mockReset();
      await show(false);
      arrange();
      await show(true);
      expect(q('[data-testid="agent-records-problem"]')!.textContent, sentence).toContain(sentence);
      expect(!!q('[data-testid="agent-records-reload"]'), sentence).toBe(retry);
      if (retry) {
        expect((q('[data-testid="agent-records-reload"]') as HTMLElement).textContent).toBe(ko.reload);
        history([line(1, 'back again')]);
        await click('[data-testid="agent-records-reload"]');
        expect(text()).toEqual(['back again']);
      }
    }
  });

  it('the phone\'s own key cannot be found → «페어링이 끊겨», another failure → the retry line', async () => {
    readStartableKeyed.mockResolvedValueOnce({ kind: 'no_phone' });
    await show();
    expect(q('[data-testid="agent-records-problem"]')!.textContent).toContain(ko.problem.notPaired);
    await show(false);
    readStartableKeyed.mockResolvedValueOnce({ kind: 'failed' });
    await show(true);
    expect(q('[data-testid="agent-records-problem"]')!.textContent).toContain(ko.problem.failed);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('a late answer of a sheet that was closed is not drawn, and the next opening reads again', async () => {
    let release: (r: Response) => void = () => {};
    fetchWithAuth.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
    await show();
    expect(q('[data-testid="agent-records-loading"]')).not.toBeNull();
    await show(false);
    phoneCall.mockResolvedValueOnce(shellAnswer([line(1, 'LATE')]));
    await act(async () => { release(json(200, { records: [row(1)], next_after: 1 })); });
    await settle();
    expect(document.body.textContent).not.toContain('LATE');
    history([line(1, 'second opening')]);
    await show(true);
    expect(text()).toEqual(['second opening']);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('a continuation that finds a key makes the whole history keyed (one page with a key is enough)', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: Array.from({ length: 100 }, (_, i) => row(i + 1)), next_after: 100 }));
    phoneCall.mockResolvedValueOnce(shellAnswer([closedLine(1, 'no_key')], { next_after: 100, have_key: false }));
    for (let i = 1; i < 10; i++) { fetchWithAuth.mockResolvedValueOnce(json(200, { records: Array.from({ length: 100 }, (_, j) => row(i * 100 + j + 1)), next_after: (i + 1) * 100 })); phoneCall.mockResolvedValueOnce(shellAnswer([], { next_after: (i + 1) * 100, have_key: false })); }
    await show();
    expect(q('[data-testid="agent-records-keyless"]')).not.toBeNull();
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1001)], next_after: 1001 }));
    phoneCall.mockResolvedValueOnce(shellAnswer([line(1001, 'now keyed')], { next_after: 1001, have_key: true }));
    await click('[data-testid="agent-records-more"]');
    expect(q('[data-testid="agent-records-keyless"]')).toBeNull();
    expect(q('[data-testid="agent-records-nokey"]')!.textContent).toBe(ko.noKey.replace('{n}', '1'));
  });

  it('a delete that answers after the sheet was closed and opened again is not drawn over the new opening', async () => {
    history([line(1, 'kept')]);
    await show();
    await click('[data-testid="agent-records-delete"]');
    let release: (r: Response) => void = () => {};
    fetchWithAuth.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
    await click('[data-testid="agent-records-delete-confirm"]'); // the delete hangs
    await show(false);
    history([line(1, 'kept'), line(2, 'also kept')]);
    await show(true);
    expect(text()).toEqual(['kept', 'also kept']);
    await act(async () => { release(json(200, { deleted: 1 })); });
    await settle();
    expect(text()).toEqual(['kept', 'also kept']); // the late answer does not blank the reopened history
    expect(q('[data-testid="agent-records-empty"]')).toBeNull();
  });

  it('a continuation that is still on its way when the delete goes through does not paint the deleted history back', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: Array.from({ length: 100 }, (_, i) => row(i + 1)), next_after: 100 }));
    phoneCall.mockResolvedValueOnce(shellAnswer([line(100, 'page one')], { next_after: 100 }));
    for (let i = 1; i < 10; i++) { fetchWithAuth.mockResolvedValueOnce(json(200, { records: Array.from({ length: 100 }, (_, j) => row(i * 100 + j + 1)), next_after: (i + 1) * 100 })); phoneCall.mockResolvedValueOnce(shellAnswer([], { next_after: (i + 1) * 100 })); }
    await show();
    let release: (r: Response) => void = () => {};
    fetchWithAuth.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
    await click('[data-testid="agent-records-more"]'); // the continuation hangs
    await click('[data-testid="agent-records-delete"]');
    fetchWithAuth.mockResolvedValueOnce(json(200, { deleted: 1 }));
    await click('[data-testid="agent-records-delete-confirm"]');
    expect(q('[data-testid="agent-records-empty"]')).not.toBeNull();
    phoneCall.mockResolvedValueOnce(shellAnswer([line(1001, 'COMES BACK')], { next_after: 1001 }));
    await act(async () => { release(json(200, { records: [row(1001)], next_after: 1001 })); });
    await settle();
    expect(document.body.textContent).not.toContain('COMES BACK');
    expect(q('[data-testid="agent-records-empty"]')).not.toBeNull();
  });

  const computer = (setup_id: string, device_name: string, agents: string[] = []) => ({ setup_id, device_name, reachable: true, agents: agents.map((agent_member_id) => ({ agent_member_id, name: agent_member_id, can_command: true, projects: [], running: false })) });
  const SETUP_A = 'aaaaaaaa-1111-4222-8333-444444444444';
  const SETUP_B = 'bbbbbbbb-1111-4222-8333-444444444444';
  const AGENT = 'cccccccc-1111-4222-8333-444444444444';
  const urls = () => fetchWithAuth.mock.calls.map((c) => String(c[0]));

  it('a room with no session (no computer named): the sheet reads through the computer the agent is on, and says which one', async () => {
    readStartableKeyed.mockResolvedValue({ kind: 'view', phoneKeyId: PHONE, view: { remote_control: true, computers: [computer(SETUP_A, '회사 맥'), computer(SETUP_B, '집 맥', [AGENT])] } });
    history([line(1, 'kept')]);
    await show(true, 'ko', { setup: null, agent: AGENT });
    expect(text()).toEqual(['kept']);
    expect(urls()[0]).toContain(`/computers/${SETUP_B}/records`);
    expect(q('[data-testid="agent-records-computer"]')!.textContent).toBe(ko.computer.replace('{name}', '집 맥'));
    expect(JSON.stringify(phoneCall.mock.calls[0][1])).toContain(SETUP_B); // …and the shell is told the same computer
  });

  it('no computer has the agent: the first one of the phone\'s list; a blank sheet still says whose it is', async () => {
    readStartableKeyed.mockResolvedValue({ kind: 'view', phoneKeyId: PHONE, view: { remote_control: true, computers: [computer(SETUP_A, '회사 맥'), computer(SETUP_B, '집 맥')] } });
    history([]);
    await show(true, 'en', { setup: null, agent: AGENT });
    expect(urls()[0]).toContain(`/computers/${SETUP_A}/records`);
    expect(q('[data-testid="agent-records-empty"]')).not.toBeNull();
    expect(q('[data-testid="agent-records-computer"]')!.textContent).toBe(en.computer.replace('{name}', '회사 맥'));
  });

  it('the phone is paired with no computer: one line that says so, nothing is read', async () => {
    readStartableKeyed.mockResolvedValue({ kind: 'view', phoneKeyId: PHONE, view: { remote_control: true, computers: [] } });
    await show(true, 'ko', { setup: null, agent: AGENT });
    expect(q('[data-testid="agent-records-problem"]')!.textContent).toContain(ko.problem.noComputer);
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(q('[data-testid="agent-records-computer"]')).toBeNull();
    expect(q('[data-testid="agent-records-reload"]')).toBeNull(); // nothing a second press would change
  });

  it('every opening asks the phone\'s computers again (the one chosen last time may be gone), a continuation does not', async () => {
    readStartableKeyed.mockResolvedValue({ kind: 'view', phoneKeyId: PHONE, view: { remote_control: true, computers: [computer(SETUP_A, '회사 맥', [AGENT])] } });
    history([line(1, 'one')]);
    await show(true, 'ko', { setup: null, agent: AGENT });
    await show(false, 'ko', { setup: null, agent: AGENT });
    readStartableKeyed.mockResolvedValue({ kind: 'view', phoneKeyId: PHONE, view: { remote_control: true, computers: [computer(SETUP_B, '집 맥', [AGENT])] } });
    history([line(1, 'two')]);
    await show(true, 'ko', { setup: null, agent: AGENT });
    expect(urls()[1]).toContain(`/computers/${SETUP_B}/records`);
    expect(q('[data-testid="agent-records-computer"]')!.textContent).toBe(ko.computer.replace('{name}', '집 맥'));
  });

  it('a continuation reads on through the computer chosen at the opening — the phone\'s list is not asked again for it', async () => {
    readStartableKeyed.mockResolvedValue({ kind: 'view', phoneKeyId: PHONE, view: { remote_control: true, computers: [computer(SETUP_A, '회사 맥', [AGENT])] } });
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: Array.from({ length: 100 }, (_, i) => row(i + 1)), next_after: 100 }));
    phoneCall.mockResolvedValueOnce(shellAnswer([line(100, 'page one')], { next_after: 100 }));
    for (let i = 1; i < 10; i++) { fetchWithAuth.mockResolvedValueOnce(json(200, { records: Array.from({ length: 100 }, (_, j) => row(i * 100 + j + 1)), next_after: (i + 1) * 100 })); phoneCall.mockResolvedValueOnce(shellAnswer([], { next_after: (i + 1) * 100 })); }
    await show(true, 'ko', { setup: null, agent: AGENT });
    expect(readStartableKeyed).toHaveBeenCalledTimes(1);
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1001)], next_after: 1001 }));
    phoneCall.mockResolvedValueOnce(shellAnswer([line(1001, 'page eleven')], { next_after: 1001 }));
    await click('[data-testid="agent-records-more"]');
    expect(text()).toEqual(['page one', 'page eleven']);
    expect(readStartableKeyed).toHaveBeenCalledTimes(1);
    expect(urls().at(-1)).toContain(`/computers/${SETUP_A}/records`);
  });

  it('another agent while the sheet stays open starts a new read through that agent\'s computer', async () => {
    const AGENT2 = 'dddddddd-1111-4222-8333-444444444444';
    readStartableKeyed.mockResolvedValue({ kind: 'view', phoneKeyId: PHONE, view: { remote_control: true, computers: [computer(SETUP_A, '회사 맥', [AGENT]), computer(SETUP_B, '집 맥', [AGENT2])] } });
    history([line(1, 'one')]);
    await show(true, 'ko', { setup: null, agent: AGENT });
    expect(urls()[0]).toContain(`/computers/${SETUP_A}/records`);
    history([line(1, 'two')]);
    await show(true, 'ko', { setup: null, agent: AGENT2 });
    expect(urls()[1]).toContain(`/computers/${SETUP_B}/records`);
    expect(q('[data-testid="agent-records-computer"]')!.textContent).toBe(ko.computer.replace('{name}', '집 맥'));
  });

  it('a phone that is paired with nothing (no key) asks for no computer — its line is the «no computer» one; with a session\'s computer it is the «pairing cut» one', async () => {
    readStartableKeyed.mockResolvedValue({ kind: 'no_phone' });
    await show(true, 'ko', { setup: null, agent: AGENT });
    expect(q('[data-testid="agent-records-problem"]')!.textContent).toContain(ko.problem.noComputer);
    await show(false, 'ko', { setup: SETUP_A });
    await show(true, 'ko', { setup: SETUP_A });
    expect(q('[data-testid="agent-records-problem"]')!.textContent).toContain(ko.problem.notPaired);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('every opening asks the phone\'s own list again, also for a session\'s computer: a key that changed meanwhile is the key used', async () => {
    const NEWKEY = '99999999-0000-4000-8000-000000000009';
    history([line(1, 'one')]);
    await show(true, 'ko', { setup: SETUP_A, device: '회사 맥' });
    await show(false, 'ko', { setup: SETUP_A, device: '회사 맥' });
    readStartableKeyed.mockResolvedValue({ kind: 'view', phoneKeyId: NEWKEY, view: { remote_control: true, computers: [] } });
    history([line(1, 'one')]);
    await show(true, 'ko', { setup: SETUP_A, device: '회사 맥' });
    expect(readStartableKeyed).toHaveBeenCalledTimes(2);
    expect(urls()[1]).toContain(`phone_key_id=${NEWKEY}`);
  });

  it('a session that names its computer shows that computer\'s name too, and the phone\'s list is not used to pick another', async () => {
    readStartableKeyed.mockResolvedValue({ kind: 'view', phoneKeyId: PHONE, view: { remote_control: true, computers: [computer(SETUP_B, '집 맥', [AGENT])] } });
    history([line(1, 'kept')]);
    await show(true, 'ko', { setup: SETUP_A, agent: AGENT, device: '회사 맥' });
    expect(urls()[0]).toContain(`/computers/${SETUP_A}/records`);
    expect(q('[data-testid="agent-records-computer"]')!.textContent).toBe(ko.computer.replace('{name}', '회사 맥'));
  });

  it('a line\'s time is drawn in the viewer\'s own zone (ko and en), and not at all while that zone is not known — never in UTC', async () => {
    const ts = 1_790_000_000_000; // 2026-09-22 (Asia/Seoul: the morning of the 22nd, UTC: the evening of the 21st)
    history([line(1, 'timed', { ts })]);
    await show();
    const meta = () => q('[data-testid="agent-records-line"] p:last-child')!.textContent!;
    expect(meta()).toContain(new Intl.DateTimeFormat('ko', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(ts));
    zone = 'America/Los_Angeles';
    history([line(1, 'timed', { ts })]);
    await show(false); await show(true, 'en');
    expect(meta()).toContain(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Los_Angeles' }).format(ts));
    zone = null;
    history([line(1, 'timed', { ts })]);
    await show(false); await show(true, 'ko');
    expect(meta()).toBe(`${ko.instruction} · ${ko.writerPhone}`); // no date, no dangling separator
  });

  it('another room or computer while the sheet stays open starts a new read and shows nothing of the old one', async () => {
    const SETUP2 = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    const ROOM2 = '88888888-aaaa-4bbb-8ccc-dddddddddddd';
    history([line(1, 'ROOM ONE')]);
    await show();
    expect(text()).toEqual(['ROOM ONE']);
    history([line(1, 'ROOM TWO')]);
    await show(true, 'ko', { room: ROOM2 });
    expect(text()).toEqual(['ROOM TWO']);
    expect(fetchWithAuth.mock.calls.at(-1)![0]).toContain(`conversation_id=${ROOM2}`);
    history([line(1, 'SETUP TWO')]);
    await show(true, 'ko', { room: ROOM2, setup: SETUP2 });
    expect(text()).toEqual(['SETUP TWO']);
    expect(fetchWithAuth.mock.calls.at(-1)![0]).toContain(`/computers/${SETUP2}/records`);
    expect(fetchWithAuth).toHaveBeenCalledTimes(3);
  });

  it('the old read of an earlier opening never overwrites the newer opening\'s history', async () => {
    let release: (r: Response) => void = () => {};
    fetchWithAuth.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
    await show(); // opening 1 — its read hangs
    await show(false);
    history([line(1, 'NEW')]);
    await show(true); // opening 2 reads and draws
    expect(text()).toEqual(['NEW']);
    phoneCall.mockResolvedValueOnce(shellAnswer([line(1, 'OLD')]));
    await act(async () => { release(json(200, { records: [row(1)], next_after: 1 })); });
    await settle();
    expect(text()).toEqual(['NEW']); // the old answer is not drawn over it
  });

  it('a history longer than one opening reads continues from the cursor and adds to what is shown', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: Array.from({ length: 100 }, (_, i) => row(i + 1)), next_after: 100 }));
    phoneCall.mockResolvedValueOnce(shellAnswer([line(100, 'page one'), closedLine(99, 'unverified')], { next_after: 100 }));
    // 10 full pages make one opening (the limit): the mock repeats the same full page until the limit
    for (let i = 1; i < 10; i++) { fetchWithAuth.mockResolvedValueOnce(json(200, { records: Array.from({ length: 100 }, (_, j) => row(i * 100 + j + 1)), next_after: (i + 1) * 100 })); phoneCall.mockResolvedValueOnce(shellAnswer([], { next_after: (i + 1) * 100 })); }
    await show();
    expect(q('[data-testid="agent-records-more"]')).not.toBeNull();
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1001), row(1002)], next_after: 1002 }));
    phoneCall.mockResolvedValueOnce(shellAnswer([line(1001, 'page eleven'), closedLine(1002, 'unverified')], { next_after: 1002 }));
    await click('[data-testid="agent-records-more"]');
    expect(text()).toEqual(['page one', 'page eleven']);
    expect(q('[data-testid="agent-records-unverified"]')!.textContent).toBe(ko.unverified.replace('{n}', '2')); // the closed rows of BOTH reads are counted
    expect(q('[data-testid="agent-records-more"]')).toBeNull();
    expect(new URL(fetchWithAuth.mock.calls.at(-1)![0] as string, 'http://x').searchParams.get('after')).toBe('1000');
  });

  it('the second read of one opening (a continuation) does not ask again — once per OPENING, not once per read', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: Array.from({ length: 100 }, (_, i) => row(i + 1)), next_after: 100 }));
    phoneCall.mockResolvedValueOnce(shellAnswer([line(100, 'page one'), closedLine(99, 'no_key')], { next_after: 100 }));
    for (let i = 1; i < 10; i++) { fetchWithAuth.mockResolvedValueOnce(json(200, { records: Array.from({ length: 100 }, (_, j) => row(i * 100 + j + 1)), next_after: (i + 1) * 100 })); phoneCall.mockResolvedValueOnce(shellAnswer([], { next_after: (i + 1) * 100 })); }
    takeHandoffs.mockResolvedValueOnce({ kind: 'failed' }); // (a look that did not complete: no second read of the ten pages)
    await show();
    expect(q('[data-testid="agent-records-more"]')).not.toBeNull();
    expect(takeHandoffs).toHaveBeenCalledTimes(1); // the first read met a line with no generation: one look (it took nothing)
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1001), row(1002)], next_after: 1002 }));
    phoneCall.mockResolvedValueOnce(shellAnswer([line(1001, 'page eleven'), closedLine(1002, 'no_key')], { next_after: 1002 }));
    await click('[data-testid="agent-records-more"]');
    expect(text()).toEqual(['page one', 'page eleven']);
    expect(takeHandoffs).toHaveBeenCalledTimes(1); // the continuation met one too: not asked again within this opening
  });

  it('the delete asks once, says WHAT goes (the server\'s history of this chat) and cannot be undone; cancel changes nothing; confirm deletes and shows the empty state', async () => {
    history([line(1, 'one')]);
    await show();
    expect((q('[data-testid="agent-records-delete"]') as HTMLElement).textContent).toBe(ko.delete.button);
    await click('[data-testid="agent-records-delete"]');
    expect(document.body.textContent).toContain(ko.delete.body);
    expect(ko.delete.body).toContain('서버에 있는'); expect(ko.delete.body).toContain('되돌릴 수 없어요');
    const cancel = all('button').find((b) => b.textContent === ko.delete.cancel) as HTMLButtonElement;
    await act(async () => { cancel.click(); });
    await settle();
    expect(fetchWithAuth.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toHaveLength(0);
    expect(text()).toEqual(['one']);
    await click('[data-testid="agent-records-delete"]');
    fetchWithAuth.mockResolvedValueOnce(json(200, { deleted: 1 }));
    await click('[data-testid="agent-records-delete-confirm"]');
    const del = fetchWithAuth.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')!;
    expect(del[0]).toBe(`/api/desktop/records?conversation_id=${ROOM}`);
    expect(q('[data-testid="agent-records-empty"]')).not.toBeNull();
    expect(q('[data-testid="agent-records-delete"]')).toBeNull();
  });

  it('a delete that failed says so and leaves the list as it was', async () => {
    history([line(1, 'kept')]);
    await show();
    await click('[data-testid="agent-records-delete"]');
    fetchWithAuth.mockResolvedValueOnce(json(500, {}));
    await click('[data-testid="agent-records-delete-confirm"]');
    expect(q('[data-testid="agent-records-delete-failed"]')!.textContent).toBe(ko.delete.failed);
    expect(text()).toEqual(['kept']);
  });

  // story 4977 (B3-5 · last lap run64): the computer made a NEW generation when another phone was taken off and put it for THIS phone, which sat in the front and had not taken it — every line after the removal read
  // «cannot be opened on this phone». A line this phone cannot open for want of a generation is the moment to ask for it (once per opening), and what the shell took is read again.
  it('a line sealed under a generation this phone does not hold: one look at what computers put for it — and when it took something the history is read AGAIN and the line opens', async () => {
    history([line(1, 'first'), closedLine(2, 'no_key')]);
    takeHandoffs.mockResolvedValueOnce(TOOK_ONE);
    history([line(1, 'first'), line(2, 'second')]);
    await show();
    expect(takeHandoffs).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2); // read, take, read again
    expect(text()).toEqual(['first', 'second']);
    expect(q('[data-testid="agent-records-nokey"]')).toBeNull();
  });

  it('the look found nothing (the generation is not there yet): the page is read once more, and when it still does not open the sheet says so as before', async () => {
    history([line(1, 'first'), closedLine(2, 'no_key')]);
    takeHandoffs.mockResolvedValueOnce(NOTHING_TAKEN);
    history([line(1, 'first'), closedLine(2, 'no_key')]);
    await show();
    expect(takeHandoffs).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(text()).toEqual(['first']);
    expect(q('[data-testid="agent-records-nokey"]')!.textContent).toBe(ko.noKey.replace('{n}', '1'));
    expect(all('[data-testid="agent-records-nokey"]')).toHaveLength(1);
  });

  it('another look took the handoff a moment BEFORE this one asked (this one finds nothing): the page is read again and the line opens — no stale «cannot be opened»', async () => {
    history([line(1, 'first'), closedLine(2, 'no_key')]);
    takeHandoffs.mockResolvedValueOnce(NOTHING_TAKEN); // (this look finds nothing: another look took it first)
    history([line(1, 'first'), line(2, 'second')]);
    await show();
    expect(takeHandoffs).toHaveBeenCalledTimes(1);
    expect(text()).toEqual(['first', 'second']);
    expect(q('[data-testid="agent-records-nokey"]')).toBeNull();
  });

  it('a look that did not complete (the server could not be reached) is not followed by a second read — the page as read is shown', async () => {
    history([line(1, 'first'), closedLine(2, 'no_key')]);
    takeHandoffs.mockResolvedValueOnce({ kind: 'unreachable' });
    await show();
    expect(takeHandoffs).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(all('[data-testid="agent-records-nokey"]')).toHaveLength(1);
  });

  it('a look that fails (rejects, or answers it could not) leaves the page as it was read — no error is drawn', async () => {
    history([line(1, 'first'), closedLine(2, 'no_key')]);
    takeHandoffs.mockRejectedValueOnce(new Error('boom'));
    await show();
    expect(takeHandoffs).toHaveBeenCalledTimes(1);
    expect(text()).toEqual(['first']);
    expect(all('[data-testid="agent-records-nokey"]')).toHaveLength(1);
    expect(q('[data-testid="agent-records-problem"]')).toBeNull();
  });

  it('asked ONCE per opening: a generation that does not come with the second read is not asked for in a loop — and the next opening asks again', async () => {
    history([line(1, 'first'), closedLine(2, 'no_key')]);
    takeHandoffs.mockResolvedValueOnce(TOOK_ONE);
    history([line(1, 'first'), closedLine(2, 'no_key')]); // it took something, yet the line still does not open
    await show();
    expect(takeHandoffs).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    await show(false);
    history([line(1, 'first'), closedLine(2, 'no_key')]);
    await show(true);
    expect(takeHandoffs).toHaveBeenCalledTimes(2); // a new opening is a new moment of need
  });

  it('every opening starts its look with a fresh cache (a phone paired anew has another key — the cached key id of the older opening is not used)', async () => {
    history([line(1, 'first'), closedLine(2, 'no_key')]);
    await show();
    await show(false);
    history([line(1, 'first'), closedLine(2, 'no_key')]);
    await show(true);
    expect(takeHandoffs).toHaveBeenCalledTimes(2);
    const first = (takeHandoffs.mock.calls[0]![0] as { cache: object }).cache;
    const second = (takeHandoffs.mock.calls[1]![0] as { cache: object }).cache;
    expect(second).not.toBe(first);
  });

  it('a history that opens fully asks for nothing', async () => {
    history([line(1, 'first'), line(2, 'second')]);
    await show();
    expect(takeHandoffs).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('a phone with no key at all (every line has no generation) asks too — a phone whose first handoff has not been taken is the same need', async () => {
    history([closedLine(1, 'no_key'), closedLine(2, 'no_key')], { have_key: false });
    takeHandoffs.mockResolvedValueOnce(TOOK_ONE);
    history([line(1, 'first'), line(2, 'second')]);
    await show();
    expect(takeHandoffs).toHaveBeenCalledTimes(1);
    expect(text()).toEqual(['first', 'second']);
    expect(q('[data-testid="agent-records-keyless"]')).toBeNull();
  });

  it('the sheet closed while the look was on its way: the answer is not drawn and nothing is read again', async () => {
    history([line(1, 'first'), closedLine(2, 'no_key')]);
    let release!: (v: unknown) => void;
    takeHandoffs.mockReturnValueOnce(new Promise((r) => { release = r; }));
    await show();
    await show(false);
    await act(async () => { release(TOOK_ONE); });
    await settle();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1); // no second read for a closed sheet
  });

  it('outside the phone app no look is started by the sheet (the same guard as the page\'s own watch)', async () => {
    inPhoneApp = false;
    history([line(1, 'first')]);
    await show();
    expect(startHandoffWatch).not.toHaveBeenCalled();
  });

  it('the watch of an opening is started AFTER the read\'s own look (a watch started first would race it for the same handoff)', async () => {
    const order: string[] = [];
    takeHandoffs.mockImplementationOnce(async () => { order.push('take'); return NOTHING_TAKEN; });
    startHandoffWatch.mockImplementationOnce(() => { order.push('watch'); });
    history([line(1, 'first'), closedLine(2, 'no_key')]);
    history([line(1, 'first'), line(2, 'second')]);
    await show();
    expect(order).toEqual(['take', 'watch']);
  });

  it('opening the history starts a look now and for a minute (the generation a computer made while this phone sat in the front) — once per opening, not for a closed sheet', async () => {
    history([line(1, 'first')]);
    await show();
    expect(startHandoffWatch).toHaveBeenCalledTimes(1);
    expect(startHandoffWatch.mock.calls[0]![0]).toMatchObject({ forMs: 60_000 });
    await show(false);
    expect(startHandoffWatch).toHaveBeenCalledTimes(1);
  });

  it('no internal word reaches the person: not an envelope, a generation, a key or a signature (ko and en)', () => {
    for (const messages of [ko, en]) {
      const all = JSON.stringify(messages).toLowerCase();
      for (const w of ['envelope', 'generation', 'handoff', 'signature', 'seal', '봉투', '세대', '열쇠', '서명', '봉한']) expect(all, w).not.toContain(w);
    }
    expect(ko.problem.notPaired).toContain('페어링'); expect(ko.noKey).not.toContain('열쇠');
  });
});
