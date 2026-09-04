import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanKeyExistence } from './verify-i18n-key-existence';

const MESSAGES_KO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');

// story #3420 — 이 가드가 원래 잡았어야 했던 그 사고(PR#3768, api-error.ts labelKey 6개
// 실누락)를 지금 시점 코드로 재확인한다.
//
// ⚠️이 스토리 브랜치는 develop에서 갈라졌는데, 그 6키 수리 자체는 PR#3770(story #3402
// PR2, 아직 미머지)에 있다 — 즉 **지금 이 브랜치(develop 기준)에서 스캔을 돌리면 그 6개가
// 실제로 findings에 뜬다.** 이건 버그가 아니라 이 가드가 정확히 잡아야 할 그 사고를 라이브로
// 재현해 보이는 것 — "6키가 지금 여기 없다"를 하드 assert하면 PR2 머지 시점(이 브랜치보다
// 먼저/나중 어느 쪽이든)에 따라 이 테스트가 뒤집힌다. 그래서 zero-findings를 여기서 강제
// 하지 않고, 스캐너 자체가 살아 움직이는지(keysScanned>10)와 "항상 존재해 온 안정적인 키"
// (아래 뮤테이션 표본)로 정확성을 검증한다 — PR2가 이 브랜치 위로 rebase/머지되면 그 6개도
// 자연히 findings에서 빠진다.
describe('scanKeyExistence — story #3420', () => {
  it('스캐너가 실제로 파일을 스캔한다(조용한 무력화 방지) + 지금 시점 findings를 그대로 보고한다', () => {
    const { findings, keysScanned } = scanKeyExistence();
    // keysScanned===0이면 스캐너 자체가 파일을 못 찾고 있다는 뜻.
    expect(keysScanned).toBeGreaterThan(10);
    // 지금 이 브랜치(develop, PR#3770 미포함) 기준 실제 라이브 findings를 콘솔에 남긴다 —
    // "이 가드가 왜 필요한지"를 이 테스트 실행 자체가 증거로 남긴다(PR#3768이 실제로
    // 냈던 사고 그대로).
    if (findings.length > 0) {
      console.log(`[참고] 이 브랜치(develop) 기준 현재 findings ${findings.length}건 — PR#3402 PR2 머지로 해소 예정:`, findings.map((f) => f.key));
    }
  });

  // 양성대조(뮤테이션) — 실제 messages/ko.json에서 «항상 존재해 온 안정적인 키» 하나를
  // 지웠을 때 이 가드가 정확히 그 키를 findings로 내는지. errorApprovalRequired는 site-posts
  // 발행 게이트 문구로 PR#3402보다 훨씬 앞서 있었다(PR2 머지 여부와 무관하게 안정). 파일을
  // 직접 건드리므로 반드시 원복한다.
  it('⭐뮤테이션 — ko.json에서 실제로 참조되는 안정적인 키 하나를 지우면 정확히 그 키가 findings에 뜬다', () => {
    const original = readFileSync(MESSAGES_KO, 'utf8');
    try {
      const before = scanKeyExistence();
      expect(before.findings.find((f) => f.key === 'errorApprovalRequired')).toBeUndefined();

      const parsed = JSON.parse(original);
      delete parsed.content.errorApprovalRequired;
      writeFileSync(MESSAGES_KO, JSON.stringify(parsed, null, 2) + '\n', 'utf8');

      const after = scanKeyExistence();
      const finding = after.findings.find((f) => f.key === 'errorApprovalRequired');
      expect(finding).toBeDefined();
      expect(finding?.missingLocales).toContain('ko.json');
      expect(finding?.missingLocales).not.toContain('en.json');
    } finally {
      writeFileSync(MESSAGES_KO, original, 'utf8');
    }
  });

  it('labelKey가 빈 문자열이면(소비부가 직접 조립하는 의도적 위임) 스캔에서 제외된다', () => {
    const { findings } = scanKeyExistence();
    // api-error.ts의 CHANNEL_TEXT_TOO_LONG·SITE_POST_GATE_ALREADY_HELD·CHANNEL_POST_GATE_
    // ALREADY_HELD는 labelKey: ''(빈 문자열)로 선언돼 있다 — 이게 findings로 새지 않아야
    // "빈 문자열=스캔 제외"가 실제로 동작한다는 증거.
    expect(findings.find((f) => f.key === '')).toBeUndefined();
  });
});
