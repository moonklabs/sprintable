// 4913(UI-R5) — «조직 화면은 한 쪽 틀 안에서 짓는다» 가드. 옮긴 화면(MOVED)은 틀 밖 머리 · 폭 · 옛 부품을 못 쓰고, 안 옮긴 화면은 옛 부품 수를 못 늘린다(ratchet — 옮길 때마다 아래 표에서 MOVED로 올린다).
//   G1 제목은 위 막대(OrgScreenTitle→TopBarSlot)뿐 — 본문 <h1> · ui/page-header · PageHeader 금지
//   G2 맨 바깥은 PageFrame, 폭은 reading/wide/stream — max-w-* · p-6 직접 금지
//   G3 모든 분기(로딩 · 권한 없음 · 빈 · 정상)가 «제목 + 틀»을 쌍으로 그린다
//   G4 옮긴 화면은 components/ui/* import 0, 안 옮긴 화면은 현재 값 이하
//   G5 이모지 머리(구획 머리 글자) 0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(__dirname, '..');
/** 옮긴 화면 — 이 파일들이 틀 규칙을 전부 지킨다. */
const MOVED = [
  'organization/roles/page.tsx', 'organization/trust/page.tsx', 'organization/trust/trust-utils.tsx',
  'organization/content-rules/page.tsx', 'organization/generation-connectors/page.tsx', 'rewards/page.tsx',
  'organization/channels/page.tsx', 'organization/events/page.tsx', 'content/page.tsx', 'organization/insights-board/page.tsx',
  'channel/page.tsx', // 4913 · 채널(채팅 흐름) — PageFrame stream
  'content/channel-posts/page.tsx',
  'desktop/page.tsx', // 4913 — «데스크톱 앱» 화면(제목은 위 막대 · 본문 h1 금지)
];
/** 옮긴 화면의 라우트 로딩 폴더(= FLAT_ROUTE_TOP_BAR 키) — rewards는 표에 이미 있던 키. */
const MOVED_LOADING = ['organization/roles', 'organization/trust', 'organization/content-rules', 'organization/generation-connectors', 'rewards', 'organization/channels', 'organization/events', 'content', 'organization/insights-board', 'channel', 'content/channel-posts'];
/** 옮길 화면 — 지금 옛 부품 import 수(`from '@/components/ui/…'`)의 상한. 줄이는 방향으로만 바꾼다. */
const RATCHET: Record<string, number> = {
};
const read = (rel: string) => readFileSync(join(APP, rel), 'utf8');
/** 주석을 뺀 코드(주석 속 «PageHeader» 같은 설명이 가드에 걸리지 않게). */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const OLD_UI = /from '@\/components\/ui\//g;

describe('조직 화면 한 쪽 틀 가드(4913)', () => {
  for (const rel of MOVED) {
    describe(rel, () => {
      it('⭐G1 본문 <h1> · ui/page-header · PageHeader 없음', () => {
        const c = code(rel);
        expect(c).not.toMatch(/<h1[\s>]/);
        expect(c).not.toMatch(/ui\/page-header/);
        expect(c).not.toMatch(/<PageHeader[\s>]/);
        expect(c).not.toMatch(/<TopBarSlot[\s>]/); // 제목은 OrgScreenTitle 한 길로만(같은 일을 두 길로 하지 않는다)
      });
      it('⭐G4 components/ui/* import 0', () => {
        expect(code(rel).match(OLD_UI) ?? []).toEqual([]);
      });
      it('⭐G5 이모지 문자 0', () => {
        expect(code(rel)).not.toMatch(/\p{Extended_Pictographic}/u);
      });
    });
  }

  for (const rel of MOVED.filter((r) => r.endsWith('page.tsx'))) {
    it(`⭐G2 ${rel} — PageFrame으로 시작하고 폭 클래스 · p-6을 직접 안 쓴다`, () => {
      const c = code(rel);
      expect(c).toMatch(/<PageFrame width="(reading|wide|stream)"/);
      expect(c).not.toMatch(/\bmax-w-(?:xs|sm|md|lg|xl|[2-7]xl|\[)/);
      expect(c).not.toMatch(/(?<![\w-])p-6(?![\w-])/);
      expect(c).not.toMatch(/mx-auto/);
    });
    it(`⭐G3 ${rel} — 모든 분기가 «제목 + 틀»을 쌍으로 그린다(권한 없음 · 로딩 분기에서 제목이 사라지던 길 막음)`, () => {
      const c = code(rel);
      const frames = c.match(/<(?:PageFrame|OrgScreenLoading)\b/g) ?? [];
      // 제목 = OrgScreenTitle 또는 그것을 감싼 화면 제목 컴포넌트(서버 page가 글을 못 쥘 때 — /desktop의 DesktopScreenTitle: 안에서 OrgScreenTitle을 그린다 · 아래 «감싼 제목» 시험이 그것을 못박는다)
      const pairs = c.match(/<(?:OrgScreenTitle\b[^>]*>[\s\S]*?<\/OrgScreenTitle>|DesktopScreenTitle \/>)\s*<(?:PageFrame|OrgScreenLoading)\b/g) ?? [];
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(pairs.length).toBe(frames.length);
    });
  }

  describe('4913 /desktop — 제목이 위 막대로 갔다(본문에 제목 없음)', () => {
    const COMP = join(APP, '..', '..', 'components/desktop');
    it('⭐머리 컴포넌트에 <h1> 없음(설명 줄만) — 되돌려 h1을 다시 그리면 RED', () => {
      const c = readFileSync(join(COMP, 'desktop-page-head.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(c).not.toMatch(/<h[1-6][\s>]/);
      expect(c).toMatch(/pageNote/);
    });
    it('⭐감싼 제목은 OrgScreenTitle(= 위 막대 슬롯)로 «사이드바와 같은 이름(desktop.pageTitle)»을 그린다', () => {
      const c = readFileSync(join(COMP, 'desktop-screen-title.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(c).toMatch(/<OrgScreenTitle>\{t\('pageTitle'\)\}<\/OrgScreenTitle>/);
      expect(c).not.toMatch(/<h[1-6][\s>]/);
    });
    it('⭐화면은 제목 컴포넌트를 PageFrame 앞에 그린다', () => {
      expect(code('desktop/page.tsx')).toMatch(/<DesktopScreenTitle \/>\s*<PageFrame width="wide">/);
    });
  });

  describe('G6 라우트 로딩(loading.tsx) — 옮긴 화면의 로딩도 같은 틀 + 위 막대 제목 폴백(codex 검수 4913A)', () => {
    for (const dir of MOVED_LOADING) {
      it(`⭐${dir}/loading.tsx — 옛 PageSkeleton 없이 OrgScreenLoading(틀) + RouteTopBarFallback`, () => {
        const c = code(`${dir}/loading.tsx`);
        expect(c).toMatch(/<OrgScreenLoading(?: width="(?:reading|wide|stream)")? \/>/); // 넓은 틀 화면(성과 보드)은 로딩도 같은 폭
        expect(c).toContain(`<RouteTopBarFallback route="${dir}" />`);
        expect(c).not.toMatch(/ui\/page-skeleton|<PageSkeleton/);
      });
    }
    it('⭐로딩 틀의 폭 = 화면 PageFrame의 폭(화면이 wide인데 로딩이 reading이면 도착할 때 폭이 튄다 · codex 4913D)', () => {
      for (const dir of MOVED_LOADING) {
        const pageWidth = /<PageFrame width="(reading|wide|stream)"/.exec(code(`${dir}/page.tsx`))?.[1];
        const loadWidth = /<OrgScreenLoading(?: width="(reading|wide|stream)")? \/>/.exec(code(`${dir}/loading.tsx`))?.[1] ?? 'reading';
        expect(pageWidth, `${dir}/page.tsx PageFrame`).toBeDefined();
        expect(loadWidth, dir).toBe(pageWidth);
      }
    });
    it('⭐옮긴 화면의 폴더 로딩이 덮는 «안 옮긴» 하위 화면은 자기 옛 로딩을 따로 쥔다(틀 스켈레톤이 상세 · 채널 포스트에 번쩍이지 않게 · codex 4913D)', () => {
      for (const dir of ['content/[draftId]', 'content/channel-posts/[draftId]', 'content/channel-posts/calendar', 'content/channel-posts/engagement']) {
        expect(code(`${dir}/loading.tsx`), dir).toMatch(/<PageSkeleton\b/);
        expect(code(`${dir}/loading.tsx`), dir).not.toMatch(/OrgScreenLoading/);
      }
    });
    it('⭐넓은 틀 화면(성과 보드)의 로딩도 같은 폭 — <OrgScreenLoading width="wide" />(도착 화면과 로딩이 폭이 갈리면 틀이 한 번 뜀)', () => {
      expect(code('organization/insights-board/loading.tsx')).toContain('<OrgScreenLoading width="wide" />');
      expect(code('organization/insights-board/page.tsx')).toMatch(/<PageFrame width="wide"/);
    });
    it('⭐옮긴 화면의 위 막대 제목 행이 FLAT_ROUTE_TOP_BAR 표에 있다(없으면 로딩 폴백이 빈 막대를 그린다 · codex 4913C)', () => {
      const table = readFileSync(join(APP, '..', '..', 'components/nav/flat-tab-top-bar.tsx'), 'utf8');
      for (const dir of MOVED_LOADING) expect(table, dir).toMatch(new RegExp(`(?:'${dir}'|${dir}): \\{ Title: \\w+, showContextChip: (?:true|false) \\}`));
    });
    it('⭐OrgScreenLoading은 PageFrame 위에서 «불러오는 중»을 상태로 알린다', () => {
      const c = readFileSync(join(APP, '..', '..', 'components/organization/org-screen-loading.tsx'), 'utf8');
      expect(c).toContain('<PageFrame');
      expect(c).toMatch(/role="status"/);
      expect(c).toMatch(/aria-busy="true"/);
      expect(c).toMatch(/sr-only/);
    });
  });

  it('⭐조직 구역 열한 화면은 «옮김(MOVED)»이나 «옮길 화면(RATCHET)» 한 쪽에 반드시 든다(목록에서 빠진 화면은 어떤 가드도 못 본다)', () => {
    const ELEVEN = [
      'organization/insights-board/page.tsx', 'organization/channels/page.tsx', 'organization/generation-connectors/page.tsx', 'organization/content-rules/page.tsx',
      'organization/events/page.tsx', 'organization/trust/page.tsx', 'organization/roles/page.tsx', 'content/page.tsx', 'content/channel-posts/page.tsx', 'rewards/page.tsx', 'channel/page.tsx',
    ];
    for (const rel of ELEVEN) expect(MOVED.includes(rel) || rel in RATCHET, rel).toBe(true);
    for (const rel of ELEVEN) expect(MOVED.includes(rel) && rel in RATCHET, rel + ' 둘 다에 있다').toBe(false);
  });

  describe('G4 ratchet — 안 옮긴 화면은 옛 부품 import를 늘리지 못한다', () => {
    for (const [rel, max] of Object.entries(RATCHET)) {
      it(`${rel} ≤ ${max}`, () => {
        expect((code(rel).match(OLD_UI) ?? []).length).toBeLessThanOrEqual(max);
      });
    }
    // 4913 D물결이 끝나 조직 구역 열한 화면이 전부 MOVED로 올라와 ratchet이 비었다(시험이 하나도 없는 describe는 vitest가 «No test found»로 실패시킨다). 안 옮긴 화면을 다시 올릴 일이 생기면 이 시험을 그 화면 줄로 바꾼다.
    it('⭐ratchet이 비었다 — 열한 화면이 전부 «옮김»이다(새 «안 옮긴» 화면을 RATCHET에 올리려면 이 시험을 바꿔야 한다)', () => {
      expect(Object.keys(RATCHET)).toEqual([]);
    });
  });
});
