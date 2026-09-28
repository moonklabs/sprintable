import { describe, expect, it } from 'vitest';
import { findJosaPlaceholdersInMessages, findJosaPlaceholdersInText, scanRepository } from './verify-no-josa-placeholder';

describe('findJosaPlaceholdersInText — 단위(패턴 자체)', () => {
  it('«을(를)»을 잡는다(양성대조 — story #4117이 실제로 겪은 모양)', () => {
    const hits = findJosaPlaceholdersInText('"{name}을(를) 해지할까요"', 'x.ts');
    expect(hits.length).toBe(1);
    expect(hits[0]!.label).toBe('을(를)');
  });

  it('«이(가)»·«은(는)»·«와(과)»도 각각 잡는다', () => {
    expect(findJosaPlaceholdersInText('v1이(가) 정본', 'x.py').length).toBe(1);
    expect(findJosaPlaceholdersInText('{promptFile}은(는) 그대로', 'x.ts').length).toBe(1);
    expect(findJosaPlaceholdersInText('{name}과(와) 함께', 'x.ts').length).toBe(1);
  });

  it('여는 괄호 앞이 공백이면 안 잡는다(음성대조 — derive-now-face.ts 「PO (가) 결정」 실사례, 무관한 옵션 병기)', () => {
    const hits = findJosaPlaceholdersInText('유나 v4(PO (가) 결정, f01fa94a)가', 'x.ts');
    expect(hits.length).toBe(0);
  });

  it('이미 조사가 확定된 문장(렌더 결과)은 안 잡는다', () => {
    expect(findJosaPlaceholdersInText('메인 연산 커넥터를 해지할까요', 'x.ts').length).toBe(0);
    expect(findJosaPlaceholdersInText('담롱이 아직 연결되지 않았어요', 'x.ts').length).toBe(0);
  });
});

describe('findJosaPlaceholdersInMessages — ko.json 값 스캔', () => {
  it('중첩 객체 값 안의 조사 플레이스홀더를 키 경로와 함께 잡는다', () => {
    const hits = findJosaPlaceholdersInMessages(
      { organization: { gcRevokeConfirmTitle: '{name}을(를) 해지할까요' } },
      'ko.json',
    );
    expect(hits.length).toBe(1);
    expect(hits[0]!.snippet).toContain('organization.gcRevokeConfirmTitle');
  });

  it('키 이름 자체에 패턴이 있어도(값이 아니라) 안 잡는다 — 판정 축은 값만', () => {
    const hits = findJosaPlaceholdersInMessages({ 'weird(를)Key': '정상 문구' }, 'ko.json');
    expect(hits.length).toBe(0);
  });
});

// story #4120 AC3 — 음성대조: 이 가드에 플레이스홀더 1건을 주입하면 RED가 되는지
// (findJosaPlaceholdersInText가 이미 위에서 직접 검증) 전수 스캔 함수 자체로도 재확認.
describe('story #4120 회귀가드 — 전수 스캔 0건(clean-slate)', () => {
  // #4117(PR #4497)의 organization.gcRevokeConfirmTitle이 이 PR을 develop(#4117 착지 前)
  // 위에서 만드는 동안은 아직 raw라 여기 걸린다 — 이 PR을 열기 전 #4117 착지 뒤로
  // develop 위에서 rebase하면 0건이 된다(push 前 재확認 의무, #4117 스택 브랜치 전례와 동형).
  it('새 FAIL은 없다(이 카드가 알려진 13자리를 전부 고친 뒤의 clean-slate)', () => {
    expect(scanRepository()).toEqual([]);
  });
});
