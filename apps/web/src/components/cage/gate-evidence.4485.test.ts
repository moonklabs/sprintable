// story #4485 — the web half of the gate-action contract: every action in contracts/gate-activity-actions.json (kept equal to
// what the backend writes by backend/tests/test_4485_gate_activity_actions_contract.py) has a label key in
// GATE_ACTIVITY_LABEL_KEY, and that key has words in ko and en. A key missing here showed as the raw string in «결재 이력»
// (3806 · 4898 · the delegate/toss/discussion/delivery-failure keys found in AC0).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GATE_ACTIVITY_LABEL_KEY } from './gate-evidence';
import ko from '../../../messages/ko.json';
import en from '../../../messages/en.json';

const LIST = path.resolve(__dirname, '../../../../../contracts/gate-activity-actions.json');
const actions: string[] = JSON.parse(fs.readFileSync(LIST, 'utf8')).actions;

describe('[SID:4485] every gate action the backend writes is named in «결재 이력»', () => {
  it('the closed list is read (not empty)', () => {
    expect(actions.length).toBeGreaterThan(0);
  });

  it.each(actions)('%s has a label key', (action) => {
    expect(GATE_ACTIVITY_LABEL_KEY[action], `add ${action} to GATE_ACTIVITY_LABEL_KEY (gate-evidence.tsx) with its ko/en words`).toBeTruthy();
  });

  it.each(actions)('%s has words in ko and en', (action) => {
    const key = GATE_ACTIVITY_LABEL_KEY[action];
    const koWords = (ko.cage as Record<string, string>)[key];
    const enWords = (en.cage as Record<string, string>)[key];
    expect(typeof koWords === 'string' && koWords.length > 0, `cage.${key} missing in ko.json`).toBe(true);
    expect(typeof enWords === 'string' && enWords.length > 0, `cage.${key} missing in en.json`).toBe(true);
  });
});
