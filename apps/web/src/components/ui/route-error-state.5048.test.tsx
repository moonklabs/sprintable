// story 5048 ⑤-⑥ — 길(라우트) 오류 경계 = ds ErrorState 한 모양(옛: 손으로 그린 테두리 카드 + raw <button> + bg-brand) · «없음»(404)은 알림이 아니라 ds EmptyState.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { RouteErrorState } from './route-error-state';
import NotFound from '@/app/(authenticated)/not-found';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useChatsHref: () => '/chats' }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });
const wrap = (n: ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;
async function render(n: ReactNode) { await act(async () => { root.render(wrap(n)); }); }

describe('RouteErrorState — ds ErrorState 한 모양', () => {
  it('⭐ErrorState(role=alert)이고, 다시 시도 = ds Button이 reset을 부른다 · raw 단추 0', async () => {
    const reset = vi.fn();
    await render(<RouteErrorState error={new Error('boom')} reset={reset} secondaryHref="/login" />);
    const es = container.querySelector('[data-slot="ds-error-state"]') as HTMLElement;
    expect(es).not.toBeNull();
    expect(es.getAttribute('role')).toBe('alert');
    expect(es.textContent).toContain(koMessages.common.error);
    expect(es.textContent).toContain(koMessages.common.errorDescription);
    expect(es.textContent).toContain('boom');
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.every((b) => b.getAttribute('data-slot') === 'ds-button')).toBe(true); // 옛 raw <button className="bg-brand …"> 되돌리면 RED
    expect(container.innerHTML).not.toContain('bg-brand');
    await act(async () => { buttons[0]!.click(); });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('보조 링크는 있을 때만 · 실제 목적지 + 라벨 · ds 단추 모양(<a>)', async () => {
    await render(<RouteErrorState reset={() => {}} />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    await render(<RouteErrorState reset={() => {}} secondaryHref="/docs" secondaryLabel="문서로 돌아가기" />);
    const a = container.querySelector('a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('/docs');
    expect(a.textContent).toBe('문서로 돌아가기');
    expect(a.getAttribute('data-slot')).toBe('ds-button');
  });

  it('바깥 틀: 전체 화면은 min-h-screen · compact는 min-h-[50vh] + 좌우 여백(story #4221)', async () => {
    await render(<RouteErrorState reset={() => {}} />);
    expect(container.firstElementChild!.className).toContain('min-h-screen');
    await render(<RouteErrorState reset={() => {}} compact />);
    expect(container.firstElementChild!.className).toContain('min-h-[50vh]');
    expect(container.firstElementChild!.className).toContain('px-4');
  });

  it('제목 · 설명을 주면 그대로(안 주면 common.error · errorDescription)', async () => {
    await render(<RouteErrorState reset={() => {}} title="이 프로젝트를 열지 못했어요" description="링크를 확인해 주세요" />);
    expect(container.textContent).toContain('이 프로젝트를 열지 못했어요');
    expect(container.textContent).toContain('링크를 확인해 주세요');
    expect(container.textContent).not.toContain(koMessages.common.errorDescription);
  });
});

describe('NotFound — «없음»은 알림이 아니다', () => {
  it('⭐ds EmptyState(알림 역할 없음) + 홈으로 가는 ds 단추 링크 · 옛 큰 «404» 카드 없음', async () => {
    await render(<NotFound />);
    expect(container.querySelector('[data-slot="ds-empty-state"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull(); // 에러 변환 되돌리면(ErrorState) RED
    expect(container.querySelector('[data-slot="ds-error-state"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.notFound.title);
    const a = container.querySelector('a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('/chats');
    expect(a.getAttribute('data-slot')).toBe('ds-button');
    expect(container.innerHTML).not.toContain('shadow-lg');
  });
});
