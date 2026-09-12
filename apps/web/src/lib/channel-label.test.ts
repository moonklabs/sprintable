// @vitest-environment node
//
// story 3436(묶음 6) — 채널 종류가 사람이 읽는 문구에 원문 그대로 새던 6곳(threads가
// 「sandbox · Sandbox」처럼 겹쳐 보이던 것 등)을 channelLabel() 하나로 수렴. 어휘 정본
// (유나 2026-09-05 03:56Z)을 그대로 pin — 모르는 값은 지어내지 않고 원문 폴백.
import { describe, expect, it } from 'vitest';
import { channelLabel, channelMarkColor, channelMarkInitials } from './channel-label';

function t(key: string): string {
  const table: Record<string, string> = {
    channelThreads: 'Threads',
    channelLabelHostedSite: 'Sprintable 블로그',
    channelLabelWordpress: 'WordPress',
    channelLabelSandbox: '테스트용',
    channelLabelWebhook: '웹훅',
    channelLabelX: 'X',
    channelLabelXSandbox: 'X 테스트용',
  };
  return table[key] ?? key;
}

describe('channelLabel — 어휘 정본(story 3436 묶음 6)', () => {
  it.each([
    ['threads', 'Threads'],
    ['hosted_site', 'Sprintable 블로그'],
    ['wordpress', 'WordPress'],
    ['sandbox', '테스트용'],
    // story #3808(Phase3·3-3 PR5a) — meta_ads/ads_sandbox 선례와 동형(raw "x"/
    // "x_sandbox" 원문이 화면에 새는 결함 재발 방지).
    ['x', 'X'],
    ['x_sandbox', 'X 테스트용'],
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

describe('channelMarkColor/channelMarkInitials — story #3743 행 목록 표식', () => {
  it('알려진 채널은 고정 브랜드색을 준다', () => {
    expect(channelMarkColor('threads')).toBe('#121310');
    expect(channelMarkColor('facebook')).toBe('#1877F2');
    expect(channelMarkColor('x')).toBe('#000000');
    expect(channelMarkColor('x_sandbox')).toBe('#5B6470');
  });

  it('모르는 채널은 중립색으로 폴백한다(지어내지 않는다)', () => {
    expect(channelMarkColor('some_future_channel')).toBe('#5B6470');
  });

  it('이니셜은 채널 키 첫 2글자를 대문자로 시작(sandbox 접미는 부모와 같은 이니셜)', () => {
    expect(channelMarkInitials('threads')).toBe('Th');
    expect(channelMarkInitials('facebook')).toBe('Fa');
    expect(channelMarkInitials('facebook_sandbox')).toBe('Fa');
    expect(channelMarkInitials('instagram_sandbox')).toBe('In');
    // story #3808(Phase3·3-3 PR5a) — 1글자 채널명 엣지케이스(slice(0,2)가 1글자만
    // 줘도 안 깨짐).
    expect(channelMarkInitials('x')).toBe('X');
    expect(channelMarkInitials('x_sandbox')).toBe('X');
  });
});
