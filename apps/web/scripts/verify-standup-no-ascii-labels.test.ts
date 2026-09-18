/**
 * story #3872(customer-zero·UX-v3 §⑤, 2026-09-14) — messages/ko.json의 `standup` 네임스페이스
 * 사용자 문자열 값 중 «순 ASCII 영단어만»인 값이 4건 있었다(doneLabel/planLabel/blockers/
 * blockersLabel — 「Done」·「Plan」·「Blockers」, 배포 89 「스프린트」 탭 하루 체크인 다이얼로그가
 * 그대로 노출). 기존 가드(verify-no-hanja-in-i18n.ts=한자·verify-no-agent-tone-korean-ui-text.ts
 * =「붙임」류 내부 말투)는 이 클래스(영단어 원문 미번역)를 재지 않는다 — 이 파일이 전담한다.
 *
 * 스코프를 standup 네임스페이스로 좁힌 이유(AC2 明示): 이번 카드가 실측·정정한 범위가 거기까지고,
 * 전체 messages/*.json 스캔은 다른 네임스페이스의 의도적 영단어(예: 기술 토큰·브랜드명)까지
 * 걸릴 수 있어 별도 그라운딩이 필요하다(이 카드 스코프 밖).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');

// 순수 ASCII 알파벳(+공백)만인 값 — 한글이 단 한 글자도 안 섞인 «완전 미번역» 자리만 잡는다
// (done/plan처럼 "Done (어제 한 일)"류 부분 번역은 이 정규식엔 안 걸린다 — 그 두 키는 이미
// 이번 카드에서 영문 리드를 떼어냈다, 아래 회귀가드가 별도로 고정).
const PURE_ASCII_RE = /^[A-Za-z][A-Za-z ]*$/;

function findPureAsciiValues(obj: unknown, pathPrefix = ''): Array<{ key: string; value: string }> {
  const found: Array<{ key: string; value: string }> = [];
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = pathPrefix ? `${pathPrefix}.${k}` : k;
      if (typeof v === 'string') {
        if (PURE_ASCII_RE.test(v)) found.push({ key, value: v });
      } else {
        found.push(...findPureAsciiValues(v, key));
      }
    }
  }
  return found;
}

function loadStandupNamespace(): Record<string, unknown> {
  const raw = readFileSync(path.join(MESSAGES_DIR, 'ko.json'), 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return (parsed.standup ?? {}) as Record<string, unknown>;
}

describe('messages/ko.json standup 네임스페이스 — 순 ASCII 영단어 값 0(story #3872)', () => {
  it('standup.* 값 중 완전 미번역(순 ASCII) 자리가 없다', () => {
    const hits = findPureAsciiValues(loadStandupNamespace());
    expect(hits).toEqual([]);
  });

  it('⭐양성대조 — doneLabel이 "Done"이면 이 테스트가 그 자리를 정확히 잡는다(가드 자체가 헛돌지 않음을 증명)', () => {
    const mutated = { ...loadStandupNamespace(), doneLabel: 'Done' };
    const hits = findPureAsciiValues(mutated);
    expect(hits).toContainEqual({ key: 'doneLabel', value: 'Done' });
  });

  it('done/plan(회귀가드) — 영문 리드가 다시 안 붙는다("Done ("·"Plan (" 접두 0)', () => {
    const s = loadStandupNamespace();
    expect(String(s.done)).not.toMatch(/^Done\s*\(/);
    expect(String(s.plan)).not.toMatch(/^Plan\s*\(/);
  });
});
