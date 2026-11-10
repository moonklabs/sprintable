// story 4888 (UI-5 P1) — the error text a person can read when a goal is moved to a status it cannot reach says «goal», not «epic»
// (`/api/goals/[id]` returns `err.message` of an `INVALID_TRANSITION` as a 400). The code `INVALID_TRANSITION` is what callers match — it does not move.
import { describe, expect, it } from 'vitest';
import { validateStatusTransition } from './epic-permissions';

function catchError(from: string, to: string): (Error & { code?: string }) | null {
  try { validateStatusTransition(from, to); return null; } catch (e) { return e as Error & { code?: string }; }
}

describe('validateStatusTransition — story 4888 wording', () => {
  it('a move the goal cannot make says «goal», never «epic», and keeps its code', () => {
    const err = catchError('done', 'active');
    expect(err).not.toBeNull();
    expect(err!.message).toBe("Cannot transition goal from 'done' to 'active'");
    expect(err!.message.toLowerCase()).not.toContain('epic');
    expect(err!.code).toBe('INVALID_TRANSITION');
  });

  it('a move the goal can make throws nothing', () => {
    expect(catchError('draft', 'active')).toBeNull();
    expect(catchError('active', 'done')).toBeNull();
  });
});
