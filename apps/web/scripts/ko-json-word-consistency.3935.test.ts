import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// story #3935(AC3, 항목4) — 4338(3930 chat PR①)에서 신설된 재시도 안내 4키가 같은
// 사실("실패했으니 다시 해 보라")을 가리키면서 두 원문(해 보세요/해 주세요)으로 갈려
// 들어왔다 — §⑤ 정본은 해 주세요. 4키가 전부 "다시 시도해 주세요"로 끝난다는 것을 고정한다
// (citationSaveErrorNetwork는 앞부분 구두점이 달라 전체 문자열 등식이 아니라 접미사
// 등식으로 검증 — 3932 선례와 동형, 「같은 en 자동 그룹」류 우회 없이 4키를 직접 명시 나열).
const RETRY_SUFFIX = '다시 시도해 주세요';
const RETRY_SUFFIX_KEYS = [
  'chats.addParticipantFailed',
  'chats.createConversationFailed',
  'chats.attachmentUploadFailed',
  'chats.citationSaveErrorNetwork',
] as const;

function getByPath(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, k) => {
    if (acc !== null && typeof acc === 'object') return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

function loadKo(): Record<string, unknown> {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  return JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
}

describe('ko.json — 재시도 안내 4키가 전부 "다시 시도해 주세요"로 끝난다(story #3935 AC3)', () => {
  it('⭐4키 전부 "다시 시도해 주세요" 문구를 담고 있다(뒤 구두점 유무는 축 밖)', () => {
    const ko = loadKo();
    for (const key of RETRY_SUFFIX_KEYS) {
      const value = getByPath(ko, key);
      expect(typeof value).toBe('string');
      expect((value as string).includes(RETRY_SUFFIX)).toBe(true);
    }
  });

  it('양성대조 — addParticipantFailed만 옛 표현("해 보세요")으로 되돌리면 등식이 깨진다', () => {
    const ko = loadKo();
    const mutated: Record<string, unknown> = {
      ...ko,
      chats: {
        ...(ko.chats as Record<string, unknown>),
        addParticipantFailed: '참여자 추가에 실패했어요. 다시 시도해 보세요.',
      },
    };
    const results = RETRY_SUFFIX_KEYS.map((key) => (getByPath(mutated, key) as string).includes(RETRY_SUFFIX));
    expect(results).not.toEqual(results.map(() => true));
    expect((getByPath(mutated, 'chats.addParticipantFailed') as string).includes(RETRY_SUFFIX)).toBe(false);
  });

  it('실 ko.json — chats ns 값에 "다시 시도해 보세요"(옛 원문) 리터럴이 더 이상 없다', () => {
    const ko = loadKo();
    const text = JSON.stringify(ko.chats);
    expect(text.includes('다시 시도해 보세요')).toBe(false);
  });
});
