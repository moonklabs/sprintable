// story #4274(유나 실측 · PO) — 메뉴 · 사이드바 · 탭 · ⌘K 같은 nav 표면이 프로젝트 자원(MIGRATED_RESOURCES)으로 가는 링크를 flat 주소(`/goals`)로
// 만들면, 프로젝트가 정해져 있어도 proxy의 legacyResourceRedirect(307)를 한 번 더 거치고 그 동안 로딩 경계가 설 자리가 없다(390 «전체» →
// 목표 · 문서 · 루프 1.45~1.54초 화면 그대로). nav 표면은 자원 링크를 scopedResourceHref(= `/{ws}/{proj}/{자원}` · slug 모를 때만 flat + `?p=`)
// 한 길로만 만든다. 이 가드는 그 사실을 소스로 잡는다(렌더 동작은 각 표면 테스트가 잰다).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATED_RESOURCES } from '@/lib/legacy-resource-tables';

const SRC = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// nav 표면 — 자원 링크를 만드는 자리. 각 항목은 자원 링크를 어떻게 만드는지(아래 «한 길» 검사).
const SURFACES: Array<{ file: string; via: RegExp }> = [
  { file: 'app/(authenticated)/more/page.tsx', via: /scopedResourceHref\(/ },
  { file: 'components/nav/app-sidebar.tsx', via: /scopedResourceHref\(/ },
  { file: 'components/nav/mobile-tab-bar.tsx', via: /scopedResourceHref\(|resolveWorkHref|navProjectSlug/ },
  { file: 'components/nav/nav-v3-item-list.tsx', via: /scopedResourceHref\(|scope/ },
  { file: 'components/command-palette/command-palette.tsx', via: /scopedResourceHref\(/ },
  { file: 'components/workspace/workspace-frame-tabs.tsx', via: /\/\$\{params\.ws\}\/\$\{params\.proj\}\// },
];

const KEYS = Object.keys(MIGRATED_RESOURCES).map((k) => k.replace(/[-]/g, '\\-')).join('|');
// flat 자원 링크를 «만드는» 호출 꼴: flatHref('/goals…') · withProjectParam('/docs…') · href="/loops" · router.push('/sprints') · Link href={'/…'}
const FLAT_CALL = new RegExp(String.raw`(?:flatHref|withProjectParam|withProject|push|replace)\(\s*['"\`]/(?:${KEYS})(?:['"\`/?]|\$\{)|href=\{?\s*['"\`]/(?:${KEYS})(?:['"\`/?]|\$\{)`);
// 자원 경로를 bare로 조립하는 꼴: `/${item.path}` · `/${resource}`
const BARE_TEMPLATE = /`\/\$\{[A-Za-z_.]*(?:path|resource)\}/;

describe('nav 표면의 프로젝트 자원 링크 = scopedResourceHref 한 길(story #4274)', () => {
  it.each(SURFACES)('⭐$file — flat 자원 링크 호출 0 · bare 자원 템플릿 0', ({ file }) => {
    const src = stripComments(read(file));
    const lines = src.split('\n');
    expect(lines.filter((l) => FLAT_CALL.test(l)), 'flat 자원 링크를 만드는 줄').toEqual([]);
    expect(lines.filter((l) => BARE_TEMPLATE.test(l)), 'bare 자원 템플릿').toEqual([]);
  });

  it.each(SURFACES)('$file — 자원 링크를 만드는 길이 실제로 있다(빈 파일 · 이름 바뀜으로 헛돌지 않게)', ({ file, via }) => {
    expect(stripComments(read(file))).toMatch(via);
  });

  it('검사 꼴이 실제로 잡는다(양성대조)', () => {
    expect(FLAT_CALL.test("href={flatHref('/goals')}")).toBe(true);
    expect(FLAT_CALL.test('router.push(`/docs/${slug}`)')).toBe(true);
    expect(FLAT_CALL.test('href="/loops"')).toBe(true);
    expect(FLAT_CALL.test("href={flatHref('/org-briefing')}"), 'flat 목적지(자원 아님)는 대상 아님').toBe(false);
    expect(BARE_TEMPLATE.test('const href = `/${item.path}`;')).toBe(true);
  });
});
