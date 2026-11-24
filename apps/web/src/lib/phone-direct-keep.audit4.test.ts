// story 4993 · audit 4 — the keeper must not make a road for a screen that left while it waited for the shell's answer (found by the mutant: `|| !wanted(k)` after the `direct.keep` call can be removed and every test stays green).
// A road made after the screen went is nobody's: the loop has stopped, no ping ever comes, and it lives to the Mac's idle (60 s) — and it spends one of the page's makings for nothing. Each check goes red without the line it names.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDirectKeepForTest, holdDirectRoad, type KeepEnv } from './phone-direct-keep';
import type { PhoneAnswer } from './phone-bridge';

const SETUP = '0f0e0d0c-0b0a-4908-8706-050403020100';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { __resetDirectKeepForTest(); vi.useRealTimers(); });

describe('[4993 audit 4] a screen that leaves while the shell is being asked', () => {
  it('the answer «idle» that comes after the screen went hidden makes NO road (no direct.ask)', async () => {
    const calls: string[] = []; let visible = true; const cbs = new Set<() => void>(); let answerKeep: (a: PhoneAnswer) => void = () => {};
    const phoneCall = vi.fn((type: string): Promise<PhoneAnswer> => {
      calls.push(type);
      if (type === 'shell.caps') return Promise.resolve({ id: 'c', ok: true, caps: { direct: 1, direct_keep: 1 } });
      if (type === 'direct.keep') return new Promise((res) => { answerKeep = res; });
      return Promise.resolve({ id: 'x', ok: false, code: 'no_road' } as PhoneAnswer);
    });
    const env: KeepEnv = { phoneCall, visible: () => visible, onVisibility: (cb) => { cbs.add(cb); return () => cbs.delete(cb); }, timer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); }, deps: { openFired: new Map<string, number>() } };
    const release = holdDirectRoad(SETUP, env);
    await vi.advanceTimersByTimeAsync(5); expect(calls).toEqual(['shell.caps', 'direct.keep']); // (the question is out; the shell has not answered)
    visible = false; for (const cb of [...cbs]) cb(); // the screen goes
    answerKeep({ id: 'k', state: 'idle' } as unknown as PhoneAnswer);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls.filter((c) => c === 'direct.ask')).toEqual([]);
    release();
  });
  it('control: the same answer with the screen still in front DOES make the road (so the check above proves something)', async () => {
    const calls: string[] = []; let answerKeep: (a: PhoneAnswer) => void = () => {};
    const phoneCall = vi.fn((type: string): Promise<PhoneAnswer> => {
      calls.push(type);
      if (type === 'shell.caps') return Promise.resolve({ id: 'c', ok: true, caps: { direct: 1, direct_keep: 1 } });
      if (type === 'direct.keep') return new Promise((res) => { answerKeep = res; });
      return Promise.resolve({ id: 'x', ok: false, code: 'no_road' } as PhoneAnswer);
    });
    const env: KeepEnv = { phoneCall, visible: () => true, onVisibility: () => () => {}, timer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); }, deps: { openFired: new Map<string, number>() } };
    const release = holdDirectRoad(SETUP, env);
    await vi.advanceTimersByTimeAsync(5); answerKeep({ id: 'k', state: 'idle' } as unknown as PhoneAnswer); await vi.advanceTimersByTimeAsync(50);
    expect(calls.filter((c) => c === 'direct.ask').length).toBe(1);
    release();
  });
});
