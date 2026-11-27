// story 5034 (C4) — the card vocabulary is CLOSED and a card is two words only. Red when: a kind is added or dropped without this list being looked at · the entity kinds drift from the entity
// registry (a card kind with no icon/colour/href rules) · parseCardRef lets through anything but a known kind with a UUID (an agent's extra field — html, a title, a url — never survives).
import { describe, expect, it } from 'vitest';
import { ENTITY_ICONS } from '../entity-registry';
import { CARD_KINDS, ENTITY_CARD_KINDS, isCardKind, isEntityCardKind, parseCardRef } from './card-kinds';

const ID = '0d6e953f-6d43-42c1-a87c-b023544497db';

describe('card vocabulary — closed list', () => {
  it('is exactly these kinds (changing it is a decision, not an accident)', () => {
    expect([...CARD_KINDS]).toEqual(['story', 'epic', 'task', 'sprint', 'doc', 'artifact', 'hypothesis', 'evidence', 'gate', 'kanban', 'deploy', 'agent_action']);
  });
  it('entity kinds are exactly the entity registry\'s object types (one list of «objects the server knows»)', () => {
    expect([...ENTITY_CARD_KINDS].sort()).toEqual(Object.keys(ENTITY_ICONS).sort());
    for (const k of ENTITY_CARD_KINDS) expect(isCardKind(k) && isEntityCardKind(k)).toBe(true);
    for (const k of ['gate', 'kanban', 'deploy', 'agent_action'] as const) expect(isEntityCardKind(k)).toBe(false);
  });
});

describe('parseCardRef — what the server wrote on a message', () => {
  it('a known kind with a UUID reference is a card; the UUID may be upper case', () => {
    expect(parseCardRef({ kind: 'story', ref: ID })).toEqual({ kind: 'story', ref: ID });
    expect(parseCardRef({ kind: 'doc', ref: ID.toUpperCase() })).toEqual({ kind: 'doc', ref: ID.toUpperCase() });
  });
  it('keeps ONLY the two words — an extra field (html · title · url · script) is dropped, never carried', () => {
    const got = parseCardRef({ kind: 'story', ref: ID, html: '<img src=x onerror=alert(1)>', title: 'x', url: 'javascript:alert(1)' });
    expect(Object.keys(got!).sort()).toEqual(['kind', 'ref']);
  });
  it.each([
    ['an unknown kind (an older app meets a newer server)', { kind: 'timeline', ref: ID }],
    ['a reference that is not a UUID', { kind: 'story', ref: 'story-12' }],
    ['a reference with a path in it', { kind: 'story', ref: `${ID}/../x` }],
    ['no reference', { kind: 'story' }],
    ['no kind', { ref: ID }],
    ['a kind that is not a string', { kind: 7, ref: ID }],
    ['an array', [{ kind: 'story', ref: ID }]],
    ['a string', 'story'],
    ['null', null],
    ['undefined', undefined],
  ])('%s → null (never throws)', (_name, raw) => {
    expect(parseCardRef(raw)).toBeNull();
  });
});
