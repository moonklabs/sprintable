import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_TONE_EXCEPTIONS, findAgentToneInMessages, scanLocaleFile } from './verify-no-agent-tone-korean-ui-text';

describe('findAgentToneInMessages — 순수 판정 함수', () => {
  it('값에 섞인 구어체 말투(붙이다)를 키 경로와 함께 잡는다', () => {
    const findings = findAgentToneInMessages({ a: { b: '여기에 붙이세요' } }, 'f.json');
    expect(findings).toEqual([{ file: 'f.json', key: 'a.b', matches: ['붙이'], value: '여기에 붙이세요' }]);
  });

  it('한 값에 서로 다른 패턴이 여러 개면 전부(중복 제거해) 보고한다', () => {
    const findings = findAgentToneInMessages({ a: '딸깍하면 붙임 처리됩니다' }, 'f.json');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.matches.sort()).toEqual(['딸깍', '붙임'].sort());
  });

  it('패턴이 없는 값은 통과한다(과잉살상 아님)', () => {
    const findings = findAgentToneInMessages({ a: { b: 'hello', c: '안녕하세요' } }, 'f.json');
    expect(findings).toEqual([]);
  });

  it('중첩 객체 전체를 재귀로 훑는다', () => {
    const findings = findAgentToneInMessages({ a: { b: { c: '딸깍 한 번으로 끝' } } }, 'f.json');
    expect(findings).toEqual([{ file: 'f.json', key: 'a.b.c', matches: ['딸깍'], value: '딸깍 한 번으로 끝' }]);
  });

  it('AGENT_TONE_EXCEPTIONS에 등록된 file·key·match 조합은 건너뛴다', () => {
    const exceptions = AGENT_TONE_EXCEPTIONS as { file: string; key: string; match: string; reason: string; addedBy: string }[];
    const before = exceptions.length;
    exceptions.push({ file: 'f.json', key: 'a', match: '딸깍', reason: 'test', addedBy: 'test' });
    try {
      const findings = findAgentToneInMessages({ a: '딸깍하고 붙이면 끝' }, 'f.json');
      // 딸깍은 예외 처리, 붙이는 예외 등록 안 됐으니 여전히 잡혀야 한다
      expect(findings).toEqual([{ file: 'f.json', key: 'a', matches: ['붙이'], value: '딸깍하고 붙이면 끝' }]);
    } finally {
      exceptions.length = before;
    }
  });
});

describe('AGENT_TONE_EXCEPTIONS — story #3824 그랜드파더 baseline', () => {
  it('그라운딩 시점 실측 8건이 전부 file·key·match·reason·addedBy 네 필드를 채워 등록돼 있다(사유 없는 예외 금지)', () => {
    expect(AGENT_TONE_EXCEPTIONS).toHaveLength(8);
    for (const e of AGENT_TONE_EXCEPTIONS) {
      expect(e.file).toBeTruthy();
      expect(e.key).toBeTruthy();
      expect(e.match).toBeTruthy();
      expect(e.reason).toBeTruthy();
      expect(e.addedBy).toBeTruthy();
    }
  });
});

// 이 가드가 «실패할 수 있음»을 코드로 고정한다(양성대조) — 잡지 못하는 가드는 「이상
// 없음」과 「검사가 안 돈다」를 구별해 주지 않는다.
describe('AC — 가드는 고의 구어체 말투 주입을 잡아낸다(양성대조)', () => {
  it('예외에 없는 신규 키에 고의로 패턴을 넣으면 빨갛게(finding 1건 이상) 된다', () => {
    const findings = findAgentToneInMessages({ someNewFeature: { hint: '여기 딸깍하면 붙임 완료' } }, 'ko.json');
    expect(findings.length).toBeGreaterThan(0);
  });
});

// story #3824 AC1 count-lock — 실 ko.json에 새로 느는 구어체 말투 자리가 baseline(8건,
// 전부 예외 등록됨)을 넘지 않는지 고정한다. 새로 생기는 자리만 막는다(can-only-shrink).
describe('실 ko.json — count-lock(baseline은 예외로 전부 흡수, 새 자리 0)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');

  it('ko.json 값에 새 구어체 말투(붙임·붙이·딸깍) 자리가 없다', () => {
    expect(scanLocaleFile(path.join(messagesDir, 'ko.json'), 'ko.json')).toEqual([]);
  });
});
