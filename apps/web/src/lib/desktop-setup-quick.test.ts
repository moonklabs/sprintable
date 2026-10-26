// story 4711 — the pure rules of the first setup in three steps (and the address the app opens the page with)
import { describe, expect, it } from 'vitest';
import { parseSetupFragment, setupFragment, parseRuntimeVersions, isFolderRefused } from './desktop-setup';
import { defaultSoloRuntime, folderTracePick, shownProjectName, soloConfirmBody, soloNewOrgConfirmBody, soloOutcome, soloStartBlock, showsQuickCard, usableRuntimes } from './desktop-setup-quick';

const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;
const PROJ = '11111111-1111-4111-8111-111111111111';
const q = (extra = '') => parseSetupFragment(`#code=${CODE}&runtimes=claude,codex&caps=move,solo${extra}`)!;

describe('[SID:4711] the address the app opens the page with', () => {
  it('reads caps=solo, the earlier pick, the versions and the folder the Mac window answered', () => {
    const r = q(`&pick=codex&rv=claude:2.1.289,codex:0.159.3&fshown=~/code/my-app&fname=my-app&fproject=${PROJ}&fwide=1`);
    expect(r).toMatchObject({ canSolo: true, canMove: true, pick: 'codex', versions: { claude: '2.1.289', codex: '0.159.3' }, folder: { shown: '~/code/my-app', name: 'my-app', projectId: PROJ, wide: true } });
  });
  it('an app from before sends none of it: the parsed shape has no solo, no folder', () => {
    const r = parseSetupFragment(`#code=${CODE}&runtimes=claude`)!;
    expect(r.canSolo).toBeUndefined();
    expect(r.folder).toBeUndefined();
  });
  it('drops what is not exactly its shape: a pick of a runtime not found · a broken version · a folder with a control character or no name · a bad project id', () => {
    expect(q('&pick=vim').pick).toBeUndefined();
    expect(parseSetupFragment(`#code=${CODE}&runtimes=claude&pick=codex`)!.pick).toBeUndefined(); // not found here
    expect(parseRuntimeVersions('claude:2.1,codex:1.2.3:9', ['claude', 'codex'])).toEqual({});
    expect(q('&fshown=%7E%2Fa%0Ab&fname=x').folder).toBeUndefined();
    expect(q('&fshown=~/a').folder).toBeUndefined();
    expect(q(`&fshown=~/a&fname=a&fproject=not-an-id`).folder).toEqual({ shown: '~/a', name: 'a' });
    expect(q('&fshown=~/a&fname=a&fwide=yes').folder).toEqual({ shown: '~/a', name: 'a' });
  });
  it('a refusal is its own answer; an unknown reason is no answer', () => {
    expect(isFolderRefused(q('&frefused=denied').folder)).toBe(true);
    expect(q('&frefused=nonsense').folder).toBeUndefined();
  });
  it('setupFragment puts every solo value back (a reload must not lose them)', () => {
    const r = q(`&pick=codex&rv=claude:2.1.289&fshown=~/code/my-app&fname=my-app&fproject=${PROJ}&fwide=1`);
    expect(parseSetupFragment(setupFragment(r))).toEqual(r);
    const refused = q('&frefused=missing');
    expect(parseSetupFragment(setupFragment(refused))).toEqual(refused);
  });
});

describe('[SID:4711] the card\'s rules', () => {
  it('the program: the earlier pick if still usable, else the first in the fixed order; a blocked one is not offered', () => {
    expect(defaultSoloRuntime(['claude', 'codex'])).toBe('claude');
    expect(defaultSoloRuntime(['claude', 'codex'], 'codex')).toBe('codex');
    expect(defaultSoloRuntime(['claude'], 'codex')).toBe('claude');
    expect(defaultSoloRuntime([])).toBeNull();
    expect(usableRuntimes({ runtimes: ['claude', 'codex'], blocked: ['claude'] })).toEqual(['codex']);
  });
  it('the confirm body carries the runtime, what the person typed for the agent, and the folder NAME (or the project id) — never a path', () => {
    const folder = { shown: '~/code/my-app', name: 'my-app' };
    const made = { name: ' Reviewer ', role: '' };
    expect(soloConfirmBody(CODE, 'claude', folder, made)).toEqual({ code: CODE, runtime: 'claude', project_name: 'my-app', agent_name: 'Reviewer', folder_name: 'my-app' }); // a blank role is left out
    expect(soloConfirmBody(CODE, 'claude', { ...folder, projectId: PROJ }, { name: 'A', role: ' 코드 리뷰어 ' })).toEqual({ code: CODE, runtime: 'claude', project_id: PROJ, agent_name: 'A', agent_role: '코드 리뷰어', folder_name: 'my-app' });
    expect(soloConfirmBody(CODE, 'claude', folder, made, PROJ)).toEqual({ code: CODE, runtime: 'claude', project_id: PROJ, agent_name: 'Reviewer', folder_name: 'my-app' }); // [넣고 만들기]
    expect(soloNewOrgConfirmBody(CODE, 'codex', folder, '내 조직', { name: 'Codex', role: 'r' })).toEqual({ code: CODE, runtime: 'codex', org_name: '내 조직', project_name: 'my-app', agent_name: 'Codex', agent_role: 'r', folder_name: 'my-app' });
  });
  it('story 4784: a 422 about the typed name or role names the field and whether it looked empty; any other 422 stays generic', () => {
    const item = (field: string, msg: string) => [{ type: 'value_error', loc: ['body', field], msg }];
    expect(soloOutcome(422, undefined, null, item('agent_name', 'Value error, must not contain control characters'))).toEqual({ kind: 'bad-text', field: 'agent_name', blank: false });
    expect(soloOutcome(422, undefined, null, item('agent_name', 'Value error, must not be blank'))).toEqual({ kind: 'bad-text', field: 'agent_name', blank: true });
    expect(soloOutcome(422, undefined, null, item('agent_role', 'Value error, must not contain control characters'))).toEqual({ kind: 'bad-text', field: 'agent_role', blank: false });
    expect(soloOutcome(422, undefined, null, item('folder_name', 'x'))).toEqual({ kind: 'generic' });
    expect(soloOutcome(422, undefined, null, 'nope')).toEqual({ kind: 'generic' });
    expect(soloOutcome(500, undefined, null, item('agent_name', 'x'))).toEqual({ kind: 'generic' });
  });
  it('story 4784: a taken name comes back with the free one (trimmed, capped); none offered → null', () => {
    expect(soloOutcome(409, { code: 'agent_name_taken', suggested_name: ' Helper 2 ' }, null)).toEqual({ kind: 'name-taken', suggested: 'Helper 2' });
    expect(soloOutcome(409, { code: 'agent_name_taken', suggested_name: 7 }, null)).toEqual({ kind: 'name-taken', suggested: null });
    expect(soloOutcome(409, { code: 'agent_name_taken' }, null)).toEqual({ kind: 'name-taken', suggested: null });
  });
  it('a taken project name is shown as «{name} 2», «{name} 3» (case and spaces ignored, as the server does)', () => {
    expect(shownProjectName('app', [])).toBe('app');
    expect(shownProjectName('app', ['App'])).toBe('app 2');
    // story 4784 (Kadir 5245): the server folds full-width letters and drops format characters, and keeps the name within 100 characters
    expect(shownProjectName('app', ['ａｐｐ'])).toBe('app 2');
    expect(shownProjectName('ap\u200bp', ['app'])).toBe('ap\u200bp 2');
    const long = 'p'.repeat(100);
    expect(shownProjectName(long, [long])).toBe(`${'p'.repeat(98)} 2`);
    expect(shownProjectName('app', ['  APP ', 'app 2'])).toBe('app 3');
  });
  it('[시작] is held with one visible reason: no agent · no folder · the wide folder not yet confirmed', () => {
    const f = { shown: '~', name: 'me' };
    expect(soloStartBlock(null, f, false)).toBe('no-agent');
    expect(soloStartBlock('claude', undefined, false)).toBe('no-folder');
    expect(soloStartBlock('claude', { ...f, wide: true }, false)).toBe('wide-unconfirmed');
    expect(soloStartBlock('claude', { ...f, wide: true }, true)).toBeNull();
    expect(soloStartBlock('claude', f, false)).toBeNull();
  });
  it('the card is for an app that said solo, unless the person chose the team path', () => {
    expect(showsQuickCard(q(), false)).toBe(true);
    expect(showsQuickCard(q(), true)).toBe(false);
    expect(showsQuickCard(parseSetupFragment(`#code=${CODE}&runtimes=claude`)!, false)).toBe(false);
  });
});

describe('[SID:4711] what the server\'s answers mean for the card', () => {
  it('the project limit names the one project (a well-formed id and a name only) — else the plain limit', () => {
    expect(soloOutcome(402, { code: 'PLAN_LIMIT_EXCEEDED', resource: 'project', existing_project: { id: PROJ, name: 'Mine' } }, null)).toEqual({ kind: 'use-existing-project', project: { id: PROJ, name: 'Mine' } });
    expect(soloOutcome(402, { code: 'PLAN_LIMIT_EXCEEDED', resource: 'project', existing_project: { id: 'x', name: 'Mine' } }, null)).toEqual({ kind: 'project-limit' });
    expect(soloOutcome(402, { code: 'PLAN_LIMIT_EXCEEDED', resource: 'project' }, null)).toEqual({ kind: 'project-limit' });
  });
  it('the agent limit, the refusals and the rest', () => {
    expect(soloOutcome(402, { code: 'PLAN_LIMIT_EXCEEDED', resource: 'agent', needed: 1, available: 0 }, null)).toEqual({ kind: 'agent-limit', counts: { needed: 1, available: 0 } });
    expect(soloOutcome(403, { code: 'not_org_admin' }, null)).toEqual({ kind: 'not-admin' });
    expect(soloOutcome(410, { code: 'code_expired' }, null)).toEqual({ kind: 'expired' });
    expect(soloOutcome(409, { code: 'has_organization' }, null)).toEqual({ kind: 'has-org' });
    expect(soloOutcome(409, { code: 'pending_invites' }, null)).toEqual({ kind: 'pending-invites' });
    expect(soloOutcome(429, undefined, '90')).toEqual({ kind: 'rate-limited', retryAfter: 90 });
    expect(soloOutcome(500, { code: 'something' }, null)).toEqual({ kind: 'generic' });
  });
});

describe('[SID:4713 AC2] the folder marks in the address, and the program they pick', () => {
  const F = '&fshown=~/a&fname=a';
  it('reads ftrace: only the table\'s two names, once each, in the table\'s order — anything else is no mark', () => {
    expect((q(`${F}&ftrace=AGENTS.md,CLAUDE.md`).folder as { traces?: string[] }).traces).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect((q(`${F}&ftrace=CLAUDE.md,CLAUDE.md,agents.md,../CLAUDE.md,X`).folder as { traces?: string[] }).traces).toEqual(['CLAUDE.md']);
    expect(q(`${F}&ftrace=nope`).folder).toEqual({ shown: '~/a', name: 'a' });
    expect(q(`${F}`).folder).toEqual({ shown: '~/a', name: 'a' });
  });
  it('the address the page builds again carries the marks (round trip)', () => {
    const r = q(`${F}&ftrace=CLAUDE.md,AGENTS.md`);
    expect(setupFragment(r)).toContain('ftrace=CLAUDE.md,AGENTS.md');
    expect(parseSetupFragment(setupFragment(r))!.folder).toEqual(r.folder);
  });
  it('folderTracePick: the first OFFERED program with a mark; none offered has one → null', () => {
    const both = { shown: '~/a', name: 'a', traces: ['CLAUDE.md', 'AGENTS.md'] as const };
    expect(folderTracePick(both, ['codex', 'claude'])).toEqual({ file: 'AGENTS.md', runtime: 'codex' }); // the found order decides
    expect(folderTracePick(both, ['claude'])).toEqual({ file: 'CLAUDE.md', runtime: 'claude' });
    expect(folderTracePick({ shown: '~/a', name: 'a', traces: ['AGENTS.md'] }, ['claude'])).toBeNull();
    expect(folderTracePick({ shown: '~/a', name: 'a' }, ['claude', 'codex'])).toBeNull();
    expect(folderTracePick(undefined, ['claude'])).toBeNull();
  });
});
