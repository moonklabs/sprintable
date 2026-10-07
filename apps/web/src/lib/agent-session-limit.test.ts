// story #4534 (relay contract v1.12): the line for a word that asks nothing of the phone, and the limit's time in this page's zone
import { describe, expect, it } from 'vitest';
import { limitHeld, limitLine, limitTime } from './agent-session-limit';

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
describe('limitTime', () => {
  it('today: the time · another day: the date too (ko · en) — in the given zone', () => {
    expect(limitTime('2026-10-05T06:20:00Z', NOW, 'ko', 'Asia/Seoul')).toBe('오후 3:20');
    expect(limitTime('2026-10-05T06:20:00Z', NOW, 'en', 'Asia/Seoul')).toBe('at 3:20 PM');
    expect(limitTime('2026-10-06T06:20:00Z', NOW, 'ko', 'Asia/Seoul')).toBe('10월 6일 오후 3:20');
    expect(limitTime('2026-10-06T06:20:00Z', NOW, 'en', 'Asia/Seoul')).toBe('Oct 6, 3:20 PM');
  });
});
