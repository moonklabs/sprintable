// story 4941 (B): an organization's DEFAULT name already ends in «의 조직» («{표시 이름}의 조직» — default-org-name.ts) — a sentence that puts «조직» after the name
// says «…의 조직 조직» (the Mac pairing window did: «Lap4906 Minh의 조직 조직 기준이에요»; two web lines too). No ko line puts a word «조직» right after an organization's name.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ko = readFileSync(path.join(__dirname, '..', '..', 'messages', 'ko.json'), 'utf8');

describe('[SID:4941] ko lines never say «{org} 조직»', () => {
  it('no ko message has an organization-name placeholder followed by «조직»', () => {
    const bad = ko.split('\n').filter((l) => /\{(org|orgName|organization)\}\s*조직/.test(l)).map((l) => l.trim().slice(0, 100));
    expect(bad).toEqual([]);
  });
  it('the two lines that did say it', () => {
    const msg = JSON.parse(ko) as { [k: string]: unknown };
    const find = (o: unknown, key: string): string | null => {
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o as Record<string, unknown>)) { if (k === key && typeof v === 'string') return v; const r = find(v, key); if (r) return r; }
      return null;
    };
    expect(find(msg, 'orgHintBody')).toBe('이 알림은 {org}의 알림이에요. 전환하면 이어서 열려요.');
    expect(find(msg, 'takenOtherOrgNamed')).toMatch(/^이 폰은 \{org\}의 컴퓨터와 이미 페어링돼 있어/);
  });
});
