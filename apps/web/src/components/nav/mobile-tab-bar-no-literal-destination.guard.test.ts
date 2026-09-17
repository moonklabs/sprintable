// story #4016 AC1 — mobile-tab-bar.tsx의 TABS 배열 정의부에 목적지 경로 문자열
// 리터럴이 없는지(전부 resolveNavV3Destinations 서술자에서 옴) 소스 텍스트로 직접
// 잠근다. 파일 전체를 grep하면 프로즈 주석(옛 /glance·/flow 설명 등)이 전부 오탐이라
// TABS 배열 리터럴 구간만 잘라서 본다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FILE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'mobile-tab-bar.tsx');

function extractTabsArrayLiteral(source: string): string {
  const start = source.indexOf('export const TABS = [');
  if (start === -1) throw new Error('TABS 배열 정의를 찾지 못함(mobile-tab-bar.tsx 구조 변경?)');
  const end = source.indexOf('] as const;', start);
  if (end === -1) throw new Error('TABS 배열의 닫는 `] as const;`를 찾지 못함');
  return source.slice(start, end);
}

describe('mobile-tab-bar.tsx — TABS 배열에 목적지 경로 문자열 리터럴 0(story #4016 AC1)', () => {
  it('⭐TABS 배열 정의부의 href 필드는 전부 함수 호출식(destHref(...))이지 문자열 리터럴이 아니다 — 되돌리면(href를 손 문자열로 바꾸면) RED', () => {
    const source = readFileSync(FILE_PATH, 'utf-8');
    const tabsBlock = extractTabsArrayLiteral(source);
    const literalHrefMatch = /href:\s*['"]/u.exec(tabsBlock);
    expect(
      literalHrefMatch,
      `TABS 배열 안에 href: '...' 형태의 문자열 리터럴이 있음(${literalHrefMatch?.[0]}) — resolveNavV3Destinations 서술자(destKey)를 거치지 않은 하드코딩 회귀`,
    ).toBeNull();
  });

  it('알려진 목적지 경로 문자열(/flow·/chats·/chat·/inbox?tab=gates·/more·/today·/org-briefing·/work-list)이 TABS 배열 리터럴 구간에 직접 등장하지 않는다', () => {
    const source = readFileSync(FILE_PATH, 'utf-8');
    const tabsBlock = extractTabsArrayLiteral(source);
    const knownPaths = ['/flow', '/chats', '/chat', '/inbox?tab=gates', '/more', '/today', '/org-briefing', '/work-list'];
    for (const p of knownPaths) {
      const hasLiteral = tabsBlock.includes(`'${p}'`) || tabsBlock.includes(`"${p}"`);
      expect(hasLiteral, `TABS 배열 안에 «${p}» 문자열 리터럴이 있음`).toBe(false);
    }
  });

  it('TABS의 4탭 전부가 destKey를 통해 resolveNavV3Destinations의 항목에 매여 있다(2⁄4탭만 매는 회귀 방지)', () => {
    const source = readFileSync(FILE_PATH, 'utf-8');
    const tabsBlock = extractTabsArrayLiteral(source);
    const destKeyMatches = [...tabsBlock.matchAll(/destKey:\s*'(\w+)'/gu)].map((m) => m[1]);
    expect(destKeyMatches).toEqual(['work', 'approvals', 'chats', 'more']);
  });
});
