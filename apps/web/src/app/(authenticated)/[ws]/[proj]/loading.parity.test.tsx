// story #4274(유나 · PO 판정 4643) — 부모 경계([ws]/[proj]/loading.tsx)가 도착 자원의 **자기 loading과 같은 모양**을 그리는지 폴더 전수로 대조.
// 자기 폴더에 비동기 서버 layout.tsx가 있는 자원(회고 · 목표 · 문서 · 실행)은 그 layout이 풀리는 동안 부모 경계가 보인다 — 모양이 다르면
// «부모 → 자기»로 두 번 바뀌고, 프레임 탭이면 탭 줄이 사라진다(보드 → 회고 ~290ms). 대상은 파일 트리에서 파생(자원 이름을 박지 않는다).
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
// 자기 loading.tsx가 있는 자원 폴더(바로 아래 한 단계) — 파일 트리에서.
const OWN = readdirSync(HERE).filter((d) => statSync(join(HERE, d)).isDirectory() && existsSync(join(HERE, d, 'loading.tsx')));

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
      const { default: Own } = await import(`./${dir}/loading.tsx`);
      nav.pathname = `/ws-1/proj-1/${dir}`;
      expect(render(<Parent />)).toBe(render(<Own />));
    });
  }

  it('자기 loading이 없는 자원(산출물 등)은 일반 스켈레톤', async () => {
    const { default: Parent } = await import('./loading');
    const { PageSkeleton } = await import('@/components/ui/page-skeleton');
    nav.pathname = '/ws-1/proj-1/artifacts';
    expect(render(<Parent />)).toBe(render(<PageSkeleton />));
  });
});
