// story #4016 AC1 — mobile-tab-bar.tsx의 PHONE_TABS 배열 정의부에 목적지 경로 문자열
// 리터럴이 없는지(전부 resolveNavV3Destinations 서술자 · nav-placement.json 의 첫 화면에서 옴) 소스 텍스트로 직접
// 잠근다. story 5031 (C1 4단계) — PHONE_TABS는 이제 DEPTH1_ITEMS.map(...) 이라 구간은 `export const PHONE_TABS = DEPTH1_ITEMS.map(` 부터 `export type TabConfig` 앞까지다. 파일 전체를 grep하면 프로즈 주석(옛 /glance·/flow 설명 등)이 전부 오탐이라
// PHONE_TABS 배열 리터럴 구간만 잘라서 본다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FILE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'mobile-tab-bar.tsx');

function extractTabsArrayLiteral(source: string): string {
  const start = source.indexOf('export const PHONE_TABS = DEPTH1_ITEMS.map(');
  if (start === -1) throw new Error('PHONE_TABS 정의(DEPTH1_ITEMS.map)를 찾지 못함(mobile-tab-bar.tsx 구조 변경?)');
  const end = source.indexOf('export type TabConfig', start);
  if (end === -1) throw new Error('PHONE_TABS 정의 뒤의 `export type TabConfig`를 찾지 못함');
  return source.slice(start, end);
}

describe('mobile-tab-bar.tsx — PHONE_TABS 배열에 목적지 경로 문자열 리터럴 0(story #4016 AC1)', () => {
  it('⭐PHONE_TABS 배열 정의부의 href 필드는 전부 함수 호출식(destHref(...))이지 문자열 리터럴이 아니다 — 되돌리면(href를 손 문자열로 바꾸면) RED', () => {
    const source = readFileSync(FILE_PATH, 'utf-8');
    const tabsBlock = extractTabsArrayLiteral(source);
    const literalHrefMatch = /href:\s*['"]/u.exec(tabsBlock);
    expect(
      literalHrefMatch,
      `PHONE_TABS 배열 안에 href: '...' 형태의 문자열 리터럴이 있음(${literalHrefMatch?.[0]}) — resolveNavV3Destinations 서술자(destKey)를 거치지 않은 하드코딩 회귀`,
    ).toBeNull();
  });

  it('알려진 목적지 경로 문자열(/flow·/chats·/chat·/inbox?tab=gates·/more·/today·/org-briefing·/work-list·/organization/workforce·/settings)이 PHONE_TABS 정의 구간에 직접 등장하지 않는다 — 문자열 리터럴은 nav-placement.json에서만 온다(story 5031)', () => {
    const source = readFileSync(FILE_PATH, 'utf-8');
    const tabsBlock = extractTabsArrayLiteral(source);
    const knownPaths = ['/flow', '/chats', '/chat', '/inbox?tab=gates', '/more', '/today', '/org-briefing', '/work-list', '/organization/workforce', '/settings'];
    for (const p of knownPaths) {
      const hasLiteral = tabsBlock.includes(`'${p}'`) || tabsBlock.includes(`"${p}"`);
      expect(hasLiteral, `PHONE_TABS 배열 안에 «${p}» 문자열 리터럴이 있음`).toBe(false);
    }
  });

  it('PHONE_TABS는 DEPTH1_ITEMS(웹 아이콘 막대와 같은 넷)에서 파생된다 — 손으로 쓴 4탭 배열(`PHONE_TABS = [`)로 되돌리면 RED(story 5031)', () => {
    const source = readFileSync(FILE_PATH, 'utf-8');
    expect(source).toContain('export const PHONE_TABS = DEPTH1_ITEMS.map(');
    expect(source).not.toContain('export const PHONE_TABS = [');
  });

  it('홈 · 채팅만 destKey로 플래그 목적지에 매이고(today · chats), 에이전트 · 설정은 destKey 없이 그 자리의 첫 화면(place.path)을 static으로 가리킨다', () => {
    const source = readFileSync(FILE_PATH, 'utf-8');
    const mapping = /const TAB_DEST_OF_PLACE = \{([^}]*)\}/u.exec(source);
    expect(mapping, 'TAB_DEST_OF_PLACE 표를 찾지 못함').not.toBeNull();
    expect(mapping![1]!.replace(/\s+/gu, ' ').trim()).toBe("home: 'today', chat: 'chats', agents: null, settings: null");
    const tabsBlock = extractTabsArrayLiteral(source);
    expect(tabsBlock).toMatch(/destHref\(\{ kind: 'static', path: place\.path \}/u);
  });
});
