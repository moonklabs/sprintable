// @vitest-environment node
//
// story 3436(묶음 6) — 채널 종류가 사람이 읽는 문구에 원문 그대로 새던 6곳(threads가
// 「sandbox · Sandbox」처럼 겹쳐 보이던 것 등)을 channelLabel() 하나로 수렴. 어휘 정본
// (유나 2026-09-05 03:56Z)을 그대로 pin — 모르는 값은 지어내지 않고 원문 폴백.
import { describe, expect, it } from 'vitest';
import { channelLabel } from './channel-label';

function t(key: string): string {
  const table: Record<string, string> = {
    channelThreads: 'Threads',
    channelLabelHostedSite: 'Sprintable 블로그',
    channelLabelWordpress: 'WordPress',
    channelLabelSandbox: '테스트용',
    channelLabelWebhook: '웹훅',
  };
  return table[key] ?? key;
}

describe('channelLabel — 어휘 정본(story 3436 묶음 6)', () => {
  it.each([
    ['threads', 'Threads'],
    ['hosted_site', 'Sprintable 블로그'],
    ['wordpress', 'WordPress'],
    ['sandbox', '테스트용'],
  ])('%s → %s', (channel, expected) => {
    expect(channelLabel(channel, t)).toBe(expected);
  });

  it('⭐webhook — 디디 ④/⑤ 착지 前이라도 키는 이미 유효(선등록, 죽은 키 스윕 대상 아님)', () => {
    expect(channelLabel('webhook', t)).toBe('웹훅');
  });

  it('모르는 채널 값은 지어내지 않고 원문 그대로 폴백한다', () => {
    expect(channelLabel('some_future_channel', t)).toBe('some_future_channel');
  });
});
