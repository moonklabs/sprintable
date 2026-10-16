import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// story 4644 (PO 10-16 · 선생님 지적 «폰 짝짓기 워딩 뭔지»): the person-facing word for connecting a phone to a computer is «페어링»
// (Yuna's table `~/.sprintable-shared/yuna/pairing-wording.md`: «페어링된 컴퓨터 · 페어링을 새로 해요 · 페어링해요»). The first sweep
// (10-09) missed three values that came later with story 4532's phone-removal confirmations and the QR limit line (commit 9d67eea531):
// `desktop.remoteDevices.confirmRemovePhone` · `…confirmRemovePhoneUnpaired` · `phonePairing.limit.after` — «짝지은 컴퓨터» · «짝짓기» ·
// «짝지어요» had come back. This pins it for EVERY value of ko.json, so a new key cannot bring the old word in again.
// A word that legitimately holds the syllable (a 반짝 or 짝수 kind of word) goes into ALLOWED with its key and a reason — never
// loosened here. Reverted (the three values back to «짝…») or a new value with 짝 → RED, and the failure names the key.
const ALLOWED: Readonly<Record<string, string>> = {};

function loadKo(): Record<string, unknown> {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  return JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
}

function stringValues(node: unknown, trail: string[] = []): [string, string][] {
  if (typeof node === 'string') return [[trail.join('.'), node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => stringValues(v, [...trail, String(i)]));
  if (node !== null && typeof node === 'object') return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => stringValues(v, [...trail, k]));
  return [];
}

describe('[SID:4644] ko.json: no «짝» in any person-facing text (the phone connection is «페어링»)', () => {
  it('no value holds «짝» (except an ALLOWED key with its reason), and the three that came back say «페어링»', () => {
    const ko = loadKo();
    const values = stringValues(ko);
    expect(values.length, 'the walk reads the whole file').toBeGreaterThan(1000);
    const found = values.filter(([key, text]) => text.includes('짝') && !(key in ALLOWED)).map(([key, text]) => `${key} → ${text}`);
    expect(found, '«짝» in a person-facing value — use «페어링» (Yuna pairing-wording.md); a real word with the syllable → ALLOWED').toEqual([]);
    for (const key of Object.keys(ALLOWED)) expect(values.some(([k]) => k === key), `ALLOWED key ${key} no longer exists — remove it`).toBe(true);

    const at = (dotted: string) => values.find(([k]) => k === dotted)?.[1];
    expect(at('desktop.remoteDevices.confirmRemovePhone')).toContain('페어링된 컴퓨터 {n}대와 모두 끊겨요');
    expect(at('desktop.remoteDevices.confirmRemovePhone')).toContain('폰에서 페어링을 새로 해요');
    expect(at('desktop.remoteDevices.confirmRemovePhoneUnpaired')).toContain('페어링된 컴퓨터는 없어요');
    expect(at('phonePairing.limit.after')).toContain('새 QR로 이어서 페어링해요');
  });
});
