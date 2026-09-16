import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL_LABEL_KEYS } from '../src/lib/channel-label';
import {
  CANONICAL_NAMESPACE,
  findDuplicatedChannelLabelKeys,
  findMissingFromCanonical,
} from './verify-channel-label-single-source';

const CHANNEL_LABEL_KEY_NAMES = Object.values(CHANNEL_LABEL_KEYS);

describe('findDuplicatedChannelLabelKeys — story #3742 셀프테스트', () => {
  // (a) POSITIVE CONTROL — channelConnect 밖에 채널 라벨 키가 재등장하면 반드시 잡는다.
  it('⭐양성대조 — content에 채널 라벨 키가 재복제되면 RED(#4082/3737 사고 재현식 그대로)', () => {
    const fixture = {
      content: { channelThreads: '스레드' },
      channelConnect: { channelThreads: '스레드' },
    };
    const violations = findDuplicatedChannelLabelKeys(fixture, ['channelThreads']);
    expect(violations).toEqual([{ namespace: 'content', key: 'channelThreads' }]);
  });

  it('⭐양성대조 — organization·content 둘 다 복제하면 둘 다 각각 잡힌다', () => {
    const fixture = {
      content: { channelThreads: '스레드' },
      organization: { channelThreads: '스레드' },
      channelConnect: { channelThreads: '스레드' },
    };
    const violations = findDuplicatedChannelLabelKeys(fixture, ['channelThreads']);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.namespace).sort()).toEqual(['content', 'organization']);
  });

  // (b) NEGATIVE CONTROL — channelConnect 자기 자신은 위반이 아니다(정본 자리).
  it('channelConnect 자기 자신에 있는 건 위반이 아니다', () => {
    const fixture = { channelConnect: { channelThreads: '스레드' } };
    expect(findDuplicatedChannelLabelKeys(fixture, ['channelThreads'])).toHaveLength(0);
  });

  it('무관한 다른 네임스페이스·무관한 다른 키는 안 걸린다(무관 PR no-op)', () => {
    const fixture = {
      content: { someUnrelatedKey: '안녕' },
      channelConnect: { channelThreads: '스레드' },
    };
    expect(findDuplicatedChannelLabelKeys(fixture, ['channelThreads'])).toHaveLength(0);
  });
});

describe('findMissingFromCanonical — story #3742 셀프테스트', () => {
  it('⭐양성대조 — channelConnect에서 빠진 키를 잡는다', () => {
    const fixture = { channelConnect: {} };
    expect(findMissingFromCanonical(fixture, ['channelThreads'])).toEqual(['channelThreads']);
  });

  it('channelConnect 네임스페이스 자체가 없으면 전부 missing으로 잡는다(fail-closed)', () => {
    const fixture = { content: {} };
    expect(findMissingFromCanonical(fixture, ['channelThreads', 'channelLabelWordpress'])).toEqual([
      'channelThreads',
      'channelLabelWordpress',
    ]);
  });

  it('전부 있으면 missing 0', () => {
    const fixture = { channelConnect: { channelThreads: '스레드' } };
    expect(findMissingFromCanonical(fixture, ['channelThreads'])).toHaveLength(0);
  });
});

// story #3742 — 실 저장소 ko.json/en.json이 진짜로 단일 출처인지(합성 픽스처가 아니라
// 실물). CHANNEL_LABEL_KEYS 자체도 실 import라 이 스토리가 걷은 19키가 모두 반영된다.
describe('실 저장소 messages — 채널 라벨 단일 출처', () => {
  for (const locale of ['ko', 'en'] as const) {
    it(`${locale}.json — channelConnect 밖 재복제 0·정본 누락 0`, () => {
      const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../messages/${locale}.json`);
      const messages = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      expect(findDuplicatedChannelLabelKeys(messages, CHANNEL_LABEL_KEY_NAMES)).toEqual([]);
      expect(findMissingFromCanonical(messages, CHANNEL_LABEL_KEY_NAMES)).toEqual([]);
    });
  }

  it('CANONICAL_NAMESPACE는 channelConnect다(상수 자체 pin)', () => {
    expect(CANONICAL_NAMESPACE).toBe('channelConnect');
  });
});
