// story 5048 ⑤-⑦ — 길(라우트) 로딩의 공용 부품 넷(PageSkeleton · WorkspaceFrameLoading · chats/loading · EpicsSkeleton)이 ds SkeletonGroup + ds Skeleton 한 모양이다(옛: ui/skeleton + role=status div + sr-only 글자).
// 막대 수 · 자리 높이는 그대로(도착 화면과 어긋나 튀지 않게 — story #4274). 이 넷을 쓰는 loading.tsx ~30개가 파일을 안 건드리고 따라온다.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PageSkeleton } from './page-skeleton';
import { WorkspaceFrameLoading } from '@/components/workspace/workspace-frame-loading';
import { EpicsSkeleton } from '@/components/epics/epics-skeleton';
import ChatsLoading from '@/app/(authenticated)/chats/loading';

vi.mock('@/components/nav/flat-tab-top-bar', () => ({ RouteTopBarFallback: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });
const wrap = (n: ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;
async function render(n: ReactNode) { await act(async () => { root.render(wrap(n)); }); }

const group = () => container.querySelector('[data-slot="ds-skeleton-group"]') as HTMLElement;
const bars = () => container.querySelectorAll('[data-slot="ds-skeleton"]');

describe('길 로딩 공용 부품 — ds SkeletonGroup 한 모양', () => {
  const CASES: Array<[string, () => ReactNode, number]> = [
    ['PageSkeleton rows(제목 · 설명 + 줄 다섯)', () => <PageSkeleton />, 2 + 5],
    ['PageSkeleton cards(성과 보드 · 카드 넷)', () => <PageSkeleton variant="cards" />, 2 + 4],
    ['PageSkeleton eyebrow(윗줄 라벨 한 막대 더)', () => <PageSkeleton eyebrow />, 3 + 5],
    ['WorkspaceFrameLoading(줄 다섯)', () => <WorkspaceFrameLoading />, 5],
    ['EpicsSkeleton(머리 둘 + 카드 여섯 × 막대 여섯)', () => <EpicsSkeleton />, 2 + 6 * 6],
    ['chats/loading(제목 막대 + 줄 여섯 × 셋)', () => <ChatsLoading />, 1 + 6 * 3],
  ];

  it.each(CASES)('⭐%s: ds SkeletonGroup(role=status · aria-busy · 이름 «불러오는 중») + ds 막대 %#', async (_n, make, count) => {
    await render(make());
    const g = group();
    expect(g).not.toBeNull();
    expect(g.getAttribute('role')).toBe('status');
    expect(g.getAttribute('aria-busy')).toBe('true');
    expect(g.getAttribute('aria-label')).toBe(koMessages.common.loading);
    expect(bars()).toHaveLength(count); // 막대 수 = 도착 화면 틀(되돌리거나 줄이면 RED)
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0); // 옛 ui/skeleton 0
    expect(container.querySelectorAll('.sr-only')).toHaveLength(0); // 옛 sr-only 글자 0 — 말은 묶음 이름 하나
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1); // 한 곳에 상태 하나
  });
});
