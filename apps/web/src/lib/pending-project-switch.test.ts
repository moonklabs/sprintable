// story #4226(까디르 재QA 011da90c2) — 전환 «대기 중 목표»의 세대 토큰: 세운 쪽이 자기 토큰으로만 지운다.
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginPendingProjectTarget,
  endPendingProjectTarget,
  getPendingProjectTarget,
  setPendingProjectTarget,
} from './pending-project-switch';

afterEach(() => { setPendingProjectTarget(null); });

describe('pending-project-switch 세대 토큰(story #4226)', () => {
  it('⭐까디르 재현 — X 시작 → Y 시작 → X 정리(언마운트) → Y의 목표가 살아 있다', () => {
    const x = beginPendingProjectTarget('proj-B');
    beginPendingProjectTarget('proj-C');
    endPendingProjectTarget(x);
    expect(getPendingProjectTarget()).toBe('proj-C');
  });

  it('자기 토큰이면 지우고 · 같은 토큰을 두 번 지워도 새 목표는 안 건드린다', () => {
    const y = beginPendingProjectTarget('proj-C');
    endPendingProjectTarget(y);
    expect(getPendingProjectTarget()).toBeNull();
    const z = beginPendingProjectTarget('proj-D');
    endPendingProjectTarget(y);
    expect(getPendingProjectTarget()).toBe('proj-D');
    endPendingProjectTarget(z);
    expect(getPendingProjectTarget()).toBeNull();
  });
});
