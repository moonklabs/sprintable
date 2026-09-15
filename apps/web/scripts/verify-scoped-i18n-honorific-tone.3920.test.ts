// story #3920 — §⑤ 마감: 잔여 16 네임스페이스 사용자 문자열 합니다체 → 해요체 +
// proofCapsule 라벨 세트 영문 역할어 한글화 + AC6 attentionQueue.kicker.
//
// story #3920 AC2 — 공유 톤 테스트(verify-scoped-i18n-honorific-tone.test.ts)는 3916 유도형
// 이후 «파일만 추가»로 새 네임스페이스를 자동 커버하므로 편집하지 않는다. 이 카드의
// 양성대조(등록·해요체 0·영문 역할어 0)는 이 별 파일에 둔다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SCOPED_NAMESPACES,
  findHonorificToneInScopedKeys,
  resolveEffectiveScopedKeys,
} from './verify-scoped-i18n-honorific-tone';

const koMessages = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json'), 'utf8'),
) as Record<string, unknown>;

const NAMESPACES_3920 = [
  'register', 'share', 'pricing', 'glance', 'orgGatePolicy', 'notFound', 'channel', 'orgBriefing',
  'session', 'activityTimeline', 'desktop', 'activation', 'proofCapsule', 'shell', 'attentionQueue', 'loopQueue',
];

function getByPath(root: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
    return undefined;
  }, root);
}

describe('story #3920 — 잔여 16 네임스페이스 등록 + 해요체 0', () => {
  it('16 네임스페이스가 모두 어조 가드 스코프(honorific-scope/*.json 유도)에 등재됐다', () => {
    for (const ns of NAMESPACES_3920) {
      expect(SCOPED_NAMESPACES).toContain(ns);
    }
  });

  it('16 네임스페이스의 실 ko.json 값에 합니다체 잔존 0(스코프 스캔·전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(koMessages).filter((k) =>
      NAMESPACES_3920.includes(k.split('.')[0]),
    );
    expect(effectiveKeys.length).toBeGreaterThan(0);
    expect(findHonorificToneInScopedKeys(koMessages, effectiveKeys)).toEqual([]);
  });
});

describe('story #3920 — proofCapsule 라벨 세트 + attentionQueue.kicker 영문 역할어 0', () => {
  // 화면 문구 속 영문 역할어(제품 개념을 영어로 부른 것). BYOM/webhook 같은 «읽는 사람이
  // 보고 오는» 기술어와 다르다 — 이 세트는 customer-zero 표면이라 한국어로 부른다.
  const ROLE_ENGLISH = /Claim|Evidence|Human gate|\bpassed\b|\bfailed\b|\bAC\b|Attention Queue/;
  const KEYS = [
    'proofCapsule.claim.label',
    'proofCapsule.evidence.label',
    'proofCapsule.gate.label',
    'proofCapsule.evidence.autoPassed',
    'proofCapsule.evidence.autoFailed',
    'proofCapsule.evidence.acMet',
    'attentionQueue.kicker',
  ];

  it.each(KEYS)('%s 값에 영문 역할어(Claim·Evidence·Human gate·passed·failed·AC·Attention Queue)가 없다', (key) => {
    const value = getByPath(koMessages, key);
    expect(typeof value).toBe('string');
    expect(ROLE_ENGLISH.test(value as string)).toBe(false);
  });

  it('⭐양성대조 — 세트 중 하나(evidence.autoPassed)를 영문으로 되돌리면 이 판정이 잡는다', () => {
    expect(ROLE_ENGLISH.test('자동검증 passed')).toBe(true);
    expect(ROLE_ENGLISH.test('자동검증 통과')).toBe(false);
  });
});
