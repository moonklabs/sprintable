import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stateRank } from './agent-state-list';

// story 5038 (C8 · PO 11-27 «웹 stateRank가 기준, 띠를 맞춤»): the order an agent's state is listed in has ONE contract — contracts/agent-state-order.json (the desktop app's repository keeps the same file byte for byte and
// orders its bottom strip by it). This is the web's side: `stateRank` is the index of the row's group in the contract's `order`, for every vector the file names.
const ROOT = path.resolve(__dirname, '../../../..');
const RAW = readFileSync(path.join(ROOT, 'contracts', 'agent-state-order.json'));
const SHA = 'd308e7776a1d224c5c74de3e6bcc350d407e72d35ecb4ef36f27dd1f6330ada4'; // the mobile repository's contracts/agent-state-order.json — a copy that drifts is a failure, not a quiet divergence
const C = JSON.parse(RAW.toString('utf8')) as {
  order: string[];
  web: { vectors: Array<{ name: string; word: string | null; limitShown: boolean; askingFirstScreen: boolean; group: string }> };
};

describe('[SID:5038] contracts/agent-state-order.json — the web list\'s order is the contract\'s', () => {
  it('the file is the mobile repository\'s byte for byte', () => { expect(createHash('sha256').update(RAW).digest('hex')).toBe(SHA); });

  for (const v of C.web.vectors) {
    it(`stateRank: ${v.name}`, () => { expect(stateRank(v.word, v.limitShown, v.askingFirstScreen)).toBe(C.order.indexOf(v.group)); });
  }

  it('⭐every group of the contract is reached by a vector, in the contract\'s order (a group moved in the list but not in the file is red)', () => {
    const reached = [...new Set(C.web.vectors.map((v) => v.group))];
    expect(reached.sort((a, b) => C.order.indexOf(a) - C.order.indexOf(b))).toEqual(C.order);
    expect(C.web.vectors.every((v) => C.order.includes(v.group))).toBe(true);
  });
});
