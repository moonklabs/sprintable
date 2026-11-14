import { describe, expect, it } from 'vitest';
import { backlinkMessageLabel, type BacklinkItem } from './entity-backlinks-section';

// story 4925 — the server now gives the card to an event that has NO stage too (`stage: null`, the key and the definition's name): the line is the name alone — never a dangling « · », never the key.
const tOrg = (k: string) => k;
const tEventCard = (k: string) => ({ genericEventHeader: '이벤트' } as Record<string, string>)[k] ?? k;
const message = (event: NonNullable<BacklinkItem['message']>['event']): BacklinkItem['message'] => ({ id: 'm1', conversation_id: 'c1', content_snippet: '[이벤트] org.acme.deploy - note: x', sender: null, event });

describe('backlinkMessageLabel — an event with no stage', () => {
  it('⭐name only', () => {
    expect(backlinkMessageLabel(message({ definition_key: 'org.acme.deploy', name: '배포 확인', stage: null, role: null, gate_type: null, approver: null }), tOrg, tEventCard)).toBe('배포 확인');
  });
  it('no definition name → «이벤트», never the key', () => {
    const label = backlinkMessageLabel(message({ definition_key: 'org.acme.deploy', name: null, stage: null, role: null, gate_type: null, approver: null }), tOrg, tEventCard);
    expect(label).toBe('이벤트');
    expect(label).not.toMatch(/org\.acme/);
  });
});
