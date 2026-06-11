import { describe, it, expect } from 'vitest';

// TEMPORARY — AC③ proof for story 2d5c8662. Intentionally fails to demonstrate the
// unmasked vitest gate now fails CI. Removed immediately after the RED run is captured.
describe('CI gate proof (2d5c8662) — REMOVE ME', () => {
  it('intentionally fails to prove the gate blocks', () => {
    expect(1).toBe(2);
  });
});
