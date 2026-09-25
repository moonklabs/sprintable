/// <reference types="vite/client" />
// story #4274(유나 · PO 판정 4643) — 부모 경계([ws]/[proj]/loading.tsx)가 도착 자원의 **자기 loading과 같은 모양**을 그리는지 폴더 전수로 대조.
// 자기 폴더에 비동기 서버 layout.tsx가 있는 자원(회고 · 목표 · 문서 · 실행)은 그 layout이 풀리는 동안 부모 경계가 보인다 — 모양이 다르면
// «부모 → 자기»로 두 번 바뀌고, 프레임 탭이면 탭 줄이 사라진다(보드 → 회고 ~290ms). 대상은 파일 트리에서 파생(자원 이름을 박지 않는다).
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import koMessages from '../../../../../messages/ko.json';
import { WORKSPACE_FRAME_TABS } from '@/components/workspace/workspace-frame-tabs';

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useParams: () => ({ ws: 'ws-1', proj: 'proj-1' }),
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const HERE = __dirname;
// 동적 조각(`[id]`)이 든 경로는 템플릿 import가 안 풀려 glob으로 전부 받아 둔다(파일 트리 전수와 같은 대상).
const LOADERS = import.meta.glob<{ default: React.ComponentType }>('./**/loading.tsx');
async function loadOwn(rel: string): Promise<React.ComponentType> {
  const key = `./${rel.split(sep).join('/')}/loading.tsx`;
  const loader = LOADERS[key];
  if (!loader) throw new Error(`glob에 없는 loading: ${key}`);
  return (await loader()).default;
}
// 자기 loading.tsx가 있는 자원 폴더(바로 아래 한 단계) — 파일 트리에서.
const OWN = readdirSync(HERE).filter((d) => statSync(join(HERE, d)).isDirectory() && existsSync(join(HERE, d, 'loading.tsx')));
// 깊은 목적지(PO 렌즈 · 예: loops/[id]) — 자기 loading.tsx가 있는 폴더를 모든 깊이에서. 도달 길이 있다(결재 상세의 «실행 보기» · 실행 목록 → 상세).
function nestedLoadingDirs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (existsSync(join(full, 'loading.tsx')) && relative(HERE, full).includes(sep)) out.push(relative(HERE, full));
    nestedLoadingDirs(full, out);
  }
  return out;
}
const NESTED = nestedLoadingDirs(HERE);
/** 폴더 경로 → 주소(동적 조각 `[x]`는 표본 값). */
const toPath = (rel: string) => `/ws-1/proj-1/${rel.split(sep).map((seg) => (/^\[.+\]$/.test(seg) ? 'sample-id' : seg)).join('/')}`;

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>,
  );
}

describe('[ws]/[proj] 부모 경계 = 도착 자원의 자기 loading 모양(story #4274)', () => {
  it('대상을 실제로 모았다 — 프레임 탭 여섯 전부 + 동적 layout 자원이 들어 있다', () => {
    for (const tab of WORKSPACE_FRAME_TABS) expect(OWN, `프레임 탭 ${tab.path}`).toContain(tab.path);
    const withLayout = OWN.filter((d) => existsSync(join(HERE, d, 'layout.tsx')));
    expect(withLayout.length).toBeGreaterThanOrEqual(1);
  });

  for (const dir of OWN) {
    it(`⭐/${'{ws}'}/${'{proj}'}/${dir} — 부모 경계가 ${dir}/loading.tsx와 같은 마크업`, async () => {
      const { default: Parent } = await import('./loading');
      const Own = await loadOwn(dir);
      nav.pathname = `/ws-1/proj-1/${dir}`;
      expect(render(<Parent />)).toBe(render(<Own />));
    });
  }

  it('깊은 목적지를 실제로 모았다(loops/[id] 등 · 빈 목록이면 이 절이 헛돈다)', () => {
    expect(NESTED.length).toBeGreaterThanOrEqual(1);
  });

  for (const rel of NESTED) {
    it(`⭐깊은 목적지 ${rel} — 부모 경계 · 거쳐 가는 자기 loading 전부가 가장 깊은 loading과 같은 마크업(두 번 바뀌지 않음)`, async () => {
      const { default: Parent } = await import('./loading');
      const Deepest = await loadOwn(rel);
      nav.pathname = toPath(rel);
      const want = render(<Deepest />);
      expect(render(<Parent />), '부모 경계').toBe(want);
      const segs = rel.split(sep);
      for (let i = 1; i < segs.length; i++) {
        const mid = segs.slice(0, i).join('/');
        if (!existsSync(join(HERE, ...segs.slice(0, i), 'loading.tsx'))) continue;
        const Mid = await loadOwn(mid);
        expect(render(<Mid />), `거쳐 가는 ${mid}/loading.tsx`).toBe(want);
      }
    });
  }

  it('자기 loading이 없는 자원(산출물 등)은 일반 스켈레톤', async () => {
    const { default: Parent } = await import('./loading');
    const { PageSkeleton } = await import('@/components/ui/page-skeleton');
    nav.pathname = '/ws-1/proj-1/artifacts';
    expect(render(<Parent />)).toBe(render(<PageSkeleton />));
  });
});
