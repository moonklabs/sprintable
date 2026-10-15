// story #4534 (relay contract v1.12): the line for a word that asks nothing of the phone, and the limit's time in this page's zone
import { describe, expect, it } from 'vitest';
import { limitHeld, limitLine, limitLooksAgain, limitTime } from './agent-session-limit';

const NOW = Date.parse('2026-10-05T03:00:00Z');
describe('limitLine', () => {
  it('by word and why — a time only where the line names one; whether it passed by this clock', () => {
    expect(limitLine('waiting_input', null, NOW)).toEqual({ key: 'waitingInput' });
    expect(limitLine('waiting_input', { self_resume: 'no' }, NOW)).toEqual({ key: 'limitNo' });
    expect(limitLine('error', null, NOW)).toEqual({ key: 'error' });
    expect(limitLine('error', {}, NOW)).toEqual({ key: 'limitErrorNoTime' });
    expect(limitLine('error', { at: '2026-10-05T05:00:00Z' }, NOW)).toEqual({ key: 'limitErrorAhead', at: '2026-10-05T05:00:00Z' });
    expect(limitLine('error', { at: '2026-10-05T02:00:00Z' }, NOW)).toEqual({ key: 'limitErrorPassed' });
    expect(limitLine('paused_limit', { at: '2026-10-05T05:00:00Z', again: true }, NOW)).toEqual({ key: 'pausedAgain', at: '2026-10-05T05:00:00Z' });
    for (const s of ['working', 'idle', 'waiting_permission', 'starting', 'stopped', 'unknown']) expect(limitLine(s, null, NOW)).toBeNull();
  });
  // story #4560 (Yuna `4560-limit-resume-copy.md` §③): held off at the limit's end — its own line on any limit word, before the time's
  it('held: its own line on each limit word, whatever the time · an unknown word or a word that is not a limit → as before', () => {
    for (const held of ['screen', 'esc_not_taken'] as const) {
      expect(limitLine('error', { at: '2026-10-05T02:00:00Z', held }, NOW)).toEqual({ key: 'limitHeld' });
      expect(limitLine('error', { at: '2026-10-05T05:00:00Z', held }, NOW)).toEqual({ key: 'limitHeld' });
      expect(limitLine('paused_limit', { at: '2026-10-05T05:00:00Z', held }, NOW)).toEqual({ key: 'limitHeld' });
      expect(limitLine('waiting_input', { self_resume: 'maybe', held }, NOW)).toEqual({ key: 'limitHeld' });
      expect(limitHeld('error', { held })).toBe(true);
    }
    expect(limitLine('error', { at: '2026-10-05T02:00:00Z', held: 'other' as never }, NOW)).toEqual({ key: 'limitErrorPassed' });
    expect(limitHeld('working', { held: 'screen' })).toBe(false);
    expect(limitLine('working', { held: 'screen' }, NOW)).toBeNull();
    expect(limitHeld('error', null)).toBe(false);
  });
});
// story #4685 (Yuna `limit-notice-1014.md` §③): the next step decides the word — a limit the APP looks at again (`looks`) is «한도로 쉬는 중»
// with its own line; a held one and one from a daemon that does not look (no `looks`) keep the old words (fail-closed)
describe('limitLooksAgain · limitLine (looks)', () => {
  it('looks + self_resume (any of the three) → the one new line; the old three only without `looks`', () => {
    for (const self_resume of ['maybe', 'no', 'unknown'] as const) {
      expect(limitLooksAgain('waiting_input', { self_resume, looks: true })).toBe(true);
      expect(limitLine('waiting_input', { self_resume, looks: true }, NOW)).toEqual({ key: 'limitLooking' });
      expect(limitLooksAgain('waiting_input', { self_resume })).toBe(false); // a daemon from before: it never looks again
    }
    expect(limitLine('waiting_input', { self_resume: 'maybe' }, NOW)).toEqual({ key: 'limitMaybe' });
    expect(limitLine('waiting_input', { self_resume: 'no' }, NOW)).toEqual({ key: 'limitNo' });
    expect(limitLine('waiting_input', { self_resume: 'unknown' }, NOW)).toEqual({ key: 'limitUnknown' });
  });
  it('a held limit stays «사용 한도» with its own line, whatever `looks` says · other words are not touched · no self_resume → not this line', () => {
    expect(limitLooksAgain('waiting_input', { self_resume: 'maybe', held: 'screen', looks: true })).toBe(false);
    expect(limitLine('waiting_input', { self_resume: 'maybe', held: 'screen', looks: true }, NOW)).toEqual({ key: 'limitHeld' });
    expect(limitLooksAgain('waiting_input', { looks: true })).toBe(false); // `looks` rides on the self_resume row only
    expect(limitLooksAgain('error', { self_resume: 'maybe', looks: true })).toBe(false);
    expect(limitLooksAgain('paused_limit', { at: '2026-10-05T05:00:00Z', looks: true })).toBe(false);
    expect(limitLine('paused_limit', { at: '2026-10-05T05:00:00Z' }, NOW)).toEqual({ key: 'paused', at: '2026-10-05T05:00:00Z' });
  });
});
describe('limitTime', () => {
  it('today: the time · another day: the date too (ko · en) — in the given zone', () => {
    expect(limitTime('2026-10-05T06:20:00Z', NOW, 'ko', 'Asia/Seoul')).toBe('오후 3:20');
    expect(limitTime('2026-10-05T06:20:00Z', NOW, 'en', 'Asia/Seoul')).toBe('at 3:20 PM');
    expect(limitTime('2026-10-06T06:20:00Z', NOW, 'ko', 'Asia/Seoul')).toBe('10월 6일 오후 3:20');
    expect(limitTime('2026-10-06T06:20:00Z', NOW, 'en', 'Asia/Seoul')).toBe('Oct 6, 3:20 PM');
  });
});
