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

// story #4291(PO) — 글자 모양 대조(위)만으로는 헬퍼가 무엇을 돌려주는지 모른다(앵커 href가 데이터 표에 flat 글자로 있어도 헬퍼를 거치면 괜찮고,
// 반대로 글자는 멀쩡해도 헬퍼가 flat을 돌려줄 수 있다). ⌘K 목적지 전부(nav 파생 · 레거시 · 앵커)를 **실제 헬퍼**(deriveNavigateItems)로 뽑아
// 결과 href로 대조한다: 프로젝트 자원이면 `/{ws}/{proj}/…` · 워크스페이스 없는 목적지는 MIGRATED 자원이 아니어야(아니면 proxy 307).
describe('⌘K 목적지 href — 헬퍼 결과로 대조(story #4291)', () => {
  const firstSegment = (href: string) => href.split('?')[0]!.split('/').filter(Boolean)[0] ?? '';

  it('⭐프로젝트 자원 목적지는 전부 `/{ws}/{proj}/…` · 워크스페이스 없는 목적지에 MIGRATED 자원 0', async () => {
    const { deriveNavigateItems, GUARD_ANCHOR_ITEMS } = await import('@/components/command-palette/command-palette');
    const items = deriveNavigateItems((resource) => `/ws-1/proj-1/${resource}`);
    const problems: string[] = [];
    for (const item of items) {
      if (item.isWorkspaceless) {
        if (firstSegment(item.href) in MIGRATED_RESOURCES) problems.push(`${item.id}: flat ${item.href} — 프로젝트 자원인데 워크스페이스 없는 주소(proxy 307)`);
      } else if (!item.href.startsWith('/ws-1/proj-1/')) {
        problems.push(`${item.id}: ${item.href} — 헬퍼가 직접 주소를 돌려주지 않음`);
      }
    }
    expect(problems).toEqual([]);
    // 앵커 전부가 실제로 직접 주소로 나왔다(목록에서 빠져 헛도는 것 방지 · 양성 하한).
    for (const anchor of GUARD_ANCHOR_ITEMS) {
      expect(items.find((i) => i.id === anchor.id)?.href, anchor.id).toBe(`/ws-1/proj-1${anchor.href}`);
    }
    expect(items.filter((i) => !i.isWorkspaceless).length).toBeGreaterThanOrEqual(GUARD_ANCHOR_ITEMS.length + 3);
  });
});

