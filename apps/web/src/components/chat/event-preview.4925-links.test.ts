import { describe, expect, it } from 'vitest';
import {
  composeEventBodyFallback, composeEventPreviewFallback, composeGenericEventLine, entityLinksToLabels, humanizeMachineEventSummary,
  type EventPreviewHelpers,
} from './event-block-card';

// story 4925 — a person's words may carry a reference the chat writes as a link («[이 일감](entity:story:<id>)»; the label is escaped when it has brackets or parentheses). A preview line and a plain text list have no chip to draw:
// the link reads as its LABEL, never as its id — and what story 4921 guarded stays guarded (an id · a path · a url · a bare entity token is not words).
const UUID = '97470487-345a-4e85-9c45-cdf901737adb';
const tEventCard = (key: string) => ({ genericEventHeader: '이벤트', memberMissing: '(탈퇴한 멤버)' } as Record<string, string>)[key] ?? key;
const names: Record<string, string> = { 'org.acme.deploy': '배포 확인', 'preset.work.assigned': '작업 배정' };
const eventDefinitionName = (key: string) => names[key];
const helpers: EventPreviewHelpers = {
  tBoard: (k) => k, tCage: (k) => k, tDashboard: (k) => k, tEventCard, tEntity: (k) => k, tOutcomeLoop: (k) => k, domainLabels: { statusLabel: () => undefined, entityTypeLabel: () => undefined }, eventDefinitionName,
};
const MACHINE = (key: string) => `[이벤트] ${key}\n- note: x`;
const LEAK = /entity:|97470487|\]\(/;

describe('entityLinksToLabels', () => {
  it('⭐a link reads as its label (escaped brackets and parentheses un-escaped, as the chat wrote them)', () => {
    expect(entityLinksToLabels(`[이 일감](entity:story:${UUID}) 배포를 확인했어요`)).toBe('이 일감 배포를 확인했어요');
    expect(entityLinksToLabels(`[\\[결함\\] 제목 \\(1\\)](entity:story:${UUID})`)).toBe('[결함] 제목 (1)');
    expect(entityLinksToLabels(`먼저 [A](entity:story:${UUID}) 그다음 [B](entity:doc:${UUID})`)).toBe('먼저 A 그다음 B');
  });
  it('a link with no label, or whose label is itself an id, stays as it was (still «not words»); a plain sentence is untouched', () => {
    expect(entityLinksToLabels(`[](entity:story:${UUID})`)).toBe(`[](entity:story:${UUID})`);
    expect(entityLinksToLabels(`[${UUID}](entity:story:${UUID})`)).toBe(`[${UUID}](entity:story:${UUID})`);
    expect(entityLinksToLabels('그냥 글 [대괄호] (괄호)')).toBe('그냥 글 [대괄호] (괄호)');
  });
});

describe('the preview line (room list · rail · bell · inbox) says the label', () => {
  const line = (note: string, key = 'org.acme.deploy') => composeEventPreviewFallback(MACHINE(key), key, { note }, { tEventCard, eventDefinitionName });
  it('⭐«name · words» with the link as its label — no id, no entity token', () => {
    expect(line(`[이 일감](entity:story:${UUID}) 배포를 확인했어요`)).toBe('배포 확인 · 이 일감 배포를 확인했어요');
    expect(line(`[이 일감](entity:story:${UUID}) 배포를 확인했어요`)).not.toMatch(LEAK);
  });
  it('what 4921 guarded stays guarded: an id · a path · a url · a bare entity token · an id-labelled link are not words (the name alone)', () => {
    for (const bad of [UUID, '/api/v2/stories/1', 'https://example.test/a', 'entity:story:abc', `[${UUID}](entity:story:${UUID})`]) {
      expect(line(bad), bad).toBe('배포 확인');
    }
  });
});

describe('the bubble list and the body model', () => {
  it('a link inside a LISTED value reads as its label too; the words keep the link (the chat renderer draws the chip)', () => {
    const model = composeEventBodyFallback(MACHINE('org.acme.deploy'), 'org.acme.deploy', { note: `[이 일감](entity:story:${UUID}) 확인`, environment: `[스테이징](entity:doc:${UUID})` }, undefined, null, helpers);
    expect(model?.words).toContain(`entity:story:${UUID}`);
    expect(model?.items).toEqual([{ label: 'environment', value: '스테이징' }]);
  });
});

describe('composeGenericEventLine — the line for a chat row whose server text is «이벤트 · …»', () => {
  it('⭐an event with no sentence of its own: the definition NAME + the person\'s words (a link as its label); no name → «이벤트»', () => {
    expect(composeGenericEventLine('org.acme.deploy', { note: `[이 일감](entity:story:${UUID}) 확인` }, { tEventCard, eventDefinitionName })).toBe('배포 확인 · 이 일감 확인');
    expect(composeGenericEventLine('org.acme.other', { note: '말' }, { tEventCard, eventDefinitionName })).toBe('이벤트 · 말');
    expect(composeGenericEventLine('org.acme.deploy', {}, { tEventCard, eventDefinitionName })).toBe('배포 확인');
  });
  it('the events that have a sentence of their own (the five presets) return null: their sentence is not replaced by a name', () => {
    for (const key of ['preset.steer.instruct', 'preset.gate.verdict', 'preset.work.status_changed', 'preset.work.assigned', 'preset.goal.measured']) {
      expect(composeGenericEventLine(key, { note: '말' }, { tEventCard, eventDefinitionName }), key).toBeNull();
    }
  });
});

describe('humanizeMachineEventSummary — the bell\'s line', () => {
  const card = { event_key: 'org.acme.deploy', payload: { note: `[이 일감](entity:story:${UUID}) 확인` } };
  it('⭐a chat row the SERVER already put in words («이벤트 · …») is said with the definition\'s name and the link as its label', () => {
    expect(humanizeMachineEventSummary('페드루: 이벤트', card, tEventCard, eventDefinitionName, true)).toBe('페드루: 배포 확인 · 이 일감 확인');
    expect(humanizeMachineEventSummary('페드루: 이벤트 · 확인', { event_key: 'org.acme.deploy', payload: { note: '확인' } }, tEventCard, eventDefinitionName, true)).toBe('페드루: 배포 확인 · 확인');
  });
  it('a row that is not a chat line keeps its own summary; so does a known preset sentence and a plain message', () => {
    expect(humanizeMachineEventSummary('페드루: 이벤트', card, tEventCard, eventDefinitionName, false)).toBe('페드루: 이벤트');
    expect(humanizeMachineEventSummary('페드루: 작업 배정 · 스토리 → 미르코', { event_key: 'preset.work.assigned', payload: { note: 'x' } }, tEventCard, eventDefinitionName, true)).toBe('페드루: 작업 배정 · 스토리 → 미르코');
    expect(humanizeMachineEventSummary('미르코: 안녕하세요', undefined, tEventCard, eventDefinitionName, true)).toBe('미르코: 안녕하세요');
  });
});
