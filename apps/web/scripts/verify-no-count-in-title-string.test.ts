import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { scanJsxFileContent, scanI18nMessages, scanRepo } from './verify-no-count-in-title-string';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const KO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const EN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/en.json');

describe('scanJsxFileContent — story #3764 셀프테스트(JSX 조립형)', () => {
  it('⭐{t(\'x\')} ({n}) → RED', () => {
    const src = `
      function C() {
        return <h2>{t('stories')} ({stories.length})</h2>;
      }
    `;
    const refs = scanJsxFileContent(src, 'fake.tsx');
    expect(refs).toHaveLength(1);
  });

  it('⭐멤버 접근 콜(t(...))도 걸린다', () => {
    const src = `<h2>{t('x')} ({group.length})</h2>;`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toHaveLength(1);
  });

  // 뮤테이션 대조 — 제목 고정 + CountBadge 형(닫는 괄호 자체가 없음)으로 되돌리면
  // 이 스캔이 반드시 0을 낸다는 것 자체를 자가 증명.
  it('뮤테이션 대조 — 제목 고정 + CountBadge 형은 GREEN(닫는 괄호 텍스트 자체가 없다)', () => {
    const src = `
      function C() {
        return <h2>{t('stories')}<CountBadge count={stories.length} /></h2>;
      }
    `;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  // 음성대조 — 괄호로 안 잇는 형(콜론·대시 등)은 대상 밖.
  it('괄호로 안 잇는 형(": "·"— ")은 GREEN', () => {
    const src = `<h2>{t('stories')}: {stories.length}</h2>;`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  it('닫는 괄호가 없는 형("(N개)"이 아니라 "(진행 중)"처럼 콜 표현식이 아닌 리터럴)은 GREEN', () => {
    const src = `<h2>{label} (진행 중)</h2>;`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  it('파싱 실패(문법 오류)면 조용히 통과하지 않고 throw한다(story #2710 AC4 동형)', () => {
    expect(() => scanJsxFileContent('export function {{{ broken', 'broken.tsx')).toThrow(/파싱 실패/);
  });
});

describe('scanI18nMessages — story #3764 셀프테스트(i18n 값형)', () => {
  it('⭐"날짜 미정 ({count})" → RED', () => {
    const refs = scanI18nMessages({ content: { x: '날짜 미정 ({count})' } });
    expect(refs).toEqual([{ key: 'content.x', value: '날짜 미정 ({count})' }]);
  });

  it('뮤테이션 대조 — 괄호 제거("날짜 미정")는 GREEN', () => {
    expect(scanI18nMessages({ content: { x: '날짜 미정' } })).toEqual([]);
  });

  // 음성대조 — 이 카드가 실 트리에서 실제로 걸렸던 3건(다른 플레이스홀더 이름류)을
  // 합성 픽스처로 고정. 셋 다 GREEN이어야 한다 — count가 아닌 다른 낱말(바이트크기·
  // 신뢰도·날짜)이거나, 플레이스홀더와 닫는 괄호 사이에 다른 글자(%)가 끼는 형.
  it('음성대조 — 끝이 {count}가 아닌 다른 이름의 플레이스홀더는 GREEN(바이트크기·신뢰도·날짜류)', () => {
    expect(scanI18nMessages({ x: { a: '한도를 넘습니다 ({finalBytes})' } })).toEqual([]);
    expect(scanI18nMessages({ x: { b: '추정 ({confidence})' } })).toEqual([]);
    expect(scanI18nMessages({ x: { c: 'Team-verified delivery ({date})' } })).toEqual([]);
  });

  it('음성대조 — billing 사용량 미터류("{current} / {limit} ({pct}%)")는 GREEN(플레이스홀더와 닫는 괄호 사이에 %가 낌)', () => {
    expect(scanI18nMessages({ x: { meter: '{current} / {limit} ({pct}%)' } })).toEqual([]);
  });

  it('중첩 네임스페이스를 점 표기로 평평화한다', () => {
    const refs = scanI18nMessages({ a: { b: { c: '구성원 ({count})' } } });
    expect(refs).toEqual([{ key: 'a.b.c', value: '구성원 ({count})' }]);
  });
});

describe('scanRepo — story #3764(실 트리 실행)', () => {
  it('실 트리(apps/web/src + ko/en.json) — JSX 조립형·i18n 값형 둘 다 0건(ALLOWLIST 제외), ALLOWLIST는 전부 실제로 걸린다', () => {
    const koMessages = JSON.parse(readFileSync(KO_PATH, 'utf8')) as Record<string, unknown>;
    const enMessages = JSON.parse(readFileSync(EN_PATH, 'utf8')) as Record<string, unknown>;
    const { jsxRefs, i18nRefs, fileCount, jsxAllowlistHit, i18nAllowlistHit } = scanRepo(SRC_ROOT, koMessages, enMessages);
    expect(fileCount).toBeGreaterThan(400);
    expect(jsxRefs).toEqual([]);
    expect(i18nRefs).toEqual([]);
    // ① 탭 라벨 2키(영구) + ② #4111 소관 2키(orgMembersListHeading·orgInvitesListHeading,
    // ko/en 둘 다 걸려 4 hit) — #4111 머지 전 지금 develop 기준.
    expect(jsxAllowlistHit.size).toBe(1);
    expect(i18nAllowlistHit.size).toBe(4);
  });
});
