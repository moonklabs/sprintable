import { describe, expect, it } from 'vitest';

// Pure helper functions extracted from chat-input.tsx for testing
function getMentionQuery(value: string, cursorPos: number): string | null {
  const before = value.slice(0, cursorPos);
  const m = before.match(/@([\w가-힣]*)$/);
  return m ? m[1] : null;
}

function applyMention(value: string, cursorPos: number, name: string): { text: string; caretPos: number } {
  const before = value.slice(0, cursorPos);
  const m = before.match(/@([\w가-힣]*)$/);
  if (!m) return { text: value, caretPos: cursorPos };
  const start = cursorPos - m[0].length;
  const replacement = `@${name} `;
  return { text: value.slice(0, start) + replacement + value.slice(cursorPos), caretPos: start + replacement.length };
}

function getEntityQuery(value: string, cursorPos: number): string | null {
  const before = value.slice(0, cursorPos);
  const m = before.match(/#([\w가-힣]*)$/);
  return m ? m[1] : null;
}

function applyEntity(
  value: string,
  cursorPos: number,
  title: string,
  entityType: string,
  entityId: string,
): { text: string; caretPos: number } {
  const before = value.slice(0, cursorPos);
  const m = before.match(/#([\w가-힣]*)$/);
  if (!m) return { text: value, caretPos: cursorPos };
  const start = cursorPos - m[0].length;
  const replacement = `[${title}](entity:${entityType}:${entityId}) `;
  return { text: value.slice(0, start) + replacement + value.slice(cursorPos), caretPos: start + replacement.length };
}

describe('getMentionQuery', () => {
  it('returns query after @', () => {
    expect(getMentionQuery('hello @mir', 10)).toBe('mir');
  });
  it('returns empty string when @ just typed', () => {
    expect(getMentionQuery('hello @', 7)).toBe('');
  });
  it('returns null when no @ present', () => {
    expect(getMentionQuery('hello world', 11)).toBeNull();
  });
  it('returns null when cursor is past @ but no word chars follow', () => {
    expect(getMentionQuery('hello @ world', 8)).toBeNull();
  });
  it('handles Korean names', () => {
    expect(getMentionQuery('@미르코', 4)).toBe('미르코');
  });
});

describe('applyMention', () => {
  it('replaces @partial with @name + space', () => {
    const { text, caretPos } = applyMention('hello @mir', 10, '미르코');
    expect(text).toBe('hello @미르코 ');
    // start=6, replacement='@미르코 '(5 chars) → caretPos=11
    expect(caretPos).toBe(11);
  });
  it('inserts after @ with empty query', () => {
    const { text } = applyMention('hello @', 7, '미르코');
    expect(text).toBe('hello @미르코 ');
  });
  it('preserves text after cursor', () => {
    const { text } = applyMention('hello @mir more text', 10, '미르코');
    expect(text).toBe('hello @미르코  more text');
  });
});

describe('getEntityQuery', () => {
  it('returns query after #', () => {
    expect(getEntityQuery('check #S35', 10)).toBe('S35');
  });
  it('returns empty string when # just typed', () => {
    expect(getEntityQuery('check #', 7)).toBe('');
  });
  it('returns null when no # present', () => {
    expect(getEntityQuery('no hash here', 12)).toBeNull();
  });
});

describe('applyEntity', () => {
  it('replaces #partial with markdown entity link', () => {
    const { text } = applyEntity('check #S35', 10, 'S35 Chat UI', 'story', 'abc-123');
    expect(text).toBe('check [S35 Chat UI](entity:story:abc-123) ');
  });
  it('caret position after insertion is correct', () => {
    const { caretPos } = applyEntity('#', 1, 'S35', 'story', 'abc-123');
    const expected = '[S35](entity:story:abc-123) '.length;
    expect(caretPos).toBe(expected);
  });
  it('preserves trailing text', () => {
    const { text } = applyEntity('see #abc and more', 8, 'Test', 'epic', 'def-456');
    expect(text).toBe('see [Test](entity:epic:def-456)  and more');
  });
});
