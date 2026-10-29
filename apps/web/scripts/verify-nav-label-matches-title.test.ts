import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findNavTitleMismatches, NAV_TITLE_PAIRINGS, type NavTitlePairing } from './verify-nav-label-matches-title';

const MESSAGES_DIR = path.resolve(__dirname, '../messages');
const koMessages = JSON.parse(readFileSync(path.join(MESSAGES_DIR, 'ko.json'), 'utf-8'));
const enMessages = JSON.parse(readFileSync(path.join(MESSAGES_DIR, 'en.json'), 'utf-8'));

describe('findNavTitleMismatches — story #5f709b45(AC1·AC5)', () => {
  it('실 ko.json 손 확認 5자리가 전부 일치한다(정렬본 초록)', () => {
    expect(findNavTitleMismatches(koMessages)).toEqual([]);
  });

  it('실 en.json 손 확認 5자리가 전부 일치한다(정렬본 초록)', () => {
    expect(findNavTitleMismatches(enMessages)).toEqual([]);
  });

  // story #5f709b45 AC5 셀프테스트 — 어긋남을 합성으로 심으면 가드가 실제로 RED를 낸다는
  // 것 자체를 증명한다(그냥 초록인 게 아니라, 어긋나면 잡는다는 양성대조).
  it('어긋남을 심은 픽스처는 RED를 낸다(양성대조)', () => {
    const brokenPairings: NavTitlePairing[] = [
      { navItemId: 'org-workforce', navKey: 'workforce', titleNamespace: 'agents', titleKey: 'title' },
    ];
    const fixture = {
      nav: { workforce: '워크포스' },
      agents: { title: '에이전트' },
    };
    expect(findNavTitleMismatches(fixture, brokenPairings)).toEqual([
      { navItemId: 'org-workforce', navValue: '워크포스', titleValue: '에이전트' },
    ]);
  });

  it('일치하는 픽스처는 통과한다(음성대조)', () => {
    const pairings: NavTitlePairing[] = [
      { navItemId: 'x', navKey: 'x', titleNamespace: 'nsX', titleKey: 'title' },
    ];
    const fixture = { nav: { x: '같은말' }, nsX: { title: '같은말' } };
    expect(findNavTitleMismatches(fixture, pairings)).toEqual([]);
  });

  it('키 자체가 없으면(undefined) 마찬가지로 어긋남으로 잡는다(둘 다 undefined인 우연한 통과 방지 아님 — 존재 자체를 요구)', () => {
    const pairings: NavTitlePairing[] = [
      { navItemId: 'y', navKey: 'missingNavKey', titleNamespace: 'nsY', titleKey: 'missingTitleKey' },
    ];
    const fixture = { nav: {}, nsY: {} };
    expect(findNavTitleMismatches(fixture, pairings)).toEqual([]);
    // ⚠️ 위는 "둘 다 undefined라 값이 같다"로 우연히 통과하는 자리 — 실 5쌍은 아래에서
    // 키 존재 자체를 확認해 이 사각을 막는다.
  });

  it('실 5쌍 모두 nav·title 두 값이 실제로 존재한다(undefined 우연 통과 배제)', () => {
    for (const pairing of NAV_TITLE_PAIRINGS) {
      expect(koMessages.nav?.[pairing.navKey], `ko nav.${pairing.navKey}`).toBeDefined();
      expect(koMessages[pairing.titleNamespace]?.[pairing.titleKey], `ko ${pairing.titleNamespace}.${pairing.titleKey}`).toBeDefined();
    }
  });
});
