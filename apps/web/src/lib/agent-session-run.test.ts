// story 4686 (AC2 · Yuna run-info-1014 §1) — the one table every place reads: model (+ «· 런타임 기본값» when nobody chose it) · thinking depth
// in the run settings screen's words · the account as received (no tail when none).
import { describe, expect, it } from 'vitest';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';
import { runEffortText, runInfoLine, runModelText, runNowText } from './agent-session-run';

const ta = (m: Record<string, string>) => (key: string) => m[key] ?? `«${key}»`;
const ko = ta(koMessages.agents as unknown as Record<string, string>);
const en = ta(enMessages.agents as unknown as Record<string, string>);

describe('agent-session-run (story 4686)', () => {
  it('model: the model that ran; «· 런타임 기본값» only when the profile did not name it; none known → the runtime default', () => {
    expect(runModelText({ model: 'claude-sonnet-5-5', model_set: true }, ko)).toBe('claude-sonnet-5-5');
    expect(runModelText({ model: 'claude-fable-5-1', model_set: false }, ko)).toBe('claude-fable-5-1 · 런타임 기본값');
    expect(runModelText({ model: 'claude-fable-5-1', model_set: false }, en)).toBe('claude-fable-5-1 · Runtime default');
    expect(runModelText({ model: 'claude-opus-5-5[1m]', model_set: true }, ko)).toBe('claude-opus-5-5[1m]'); // the tail stays as it was written
    expect(runModelText({ model: null, model_set: false }, ko)).toBe('런타임 기본값');
    expect(runModelText({}, en)).toBe('Runtime default');
    expect(runModelText({ model: 'claude-fable-5-1' }, ko)).toBe('claude-fable-5-1'); // `model_set` not told → no suffix (only a told false adds it)
  });

  it('thinking depth: the settings screen\'s words; none → «기본값»; a word this page does not know is NOT «기본값» (null: the part is left out)', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((e) => runEffortText(e, ko))).toEqual(['낮게', '보통', '높게', '아주 높게', '맥스', '울트라']);
    expect(['low', 'xhigh', 'ultra'].map((e) => runEffortText(e, en))).toEqual(['Low', 'Extra high', 'Ultra']);
    expect(runEffortText(null, ko)).toBe('기본값');
    expect(runEffortText(undefined, en)).toBe('Default');
    expect(runEffortText('turbo', ko)).toBeNull();
  });

  it('the line: «{model} · 생각 깊이 {effort} · {account}» — no account → no tail; an unknown depth leaves its part out', () => {
    const run = { model: 'claude-fable-5-1', model_set: false, effort: 'high', account: 'moonklabs (Max)' };
    expect(runInfoLine(run, ko)).toBe('claude-fable-5-1 · 런타임 기본값 · 생각 깊이 높게 · moonklabs (Max)');
    expect(runInfoLine(run, en)).toBe('claude-fable-5-1 · Runtime default · Thinking depth High · moonklabs (Max)');
    expect(runInfoLine({ model: 'gpt-5-codex', model_set: true, effort: 'medium' }, ko)).toBe('gpt-5-codex · 생각 깊이 보통');
    expect(runInfoLine({ model: null, effort: null }, en)).toBe('Runtime default · Thinking depth Default');
    expect(runInfoLine({ model: 'claude-fable-5-1', model_set: true, effort: 'turbo', account: 'yo***@moonklabs.com (Pro)' }, ko)).toBe('claude-fable-5-1 · yo***@moonklabs.com (Pro)');
  });

  it('«지금 도는 것»: the same words without the account (the account has its own line)', () => {
    expect(runNowText({ model: 'claude-fable-5-1', model_set: false, effort: 'high', account: 'moonklabs (Max)' }, ko)).toBe('claude-fable-5-1 · 런타임 기본값 · 생각 깊이 높게');
  });
});
