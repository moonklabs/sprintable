// @vitest-environment jsdom
//
// story #4336 PR2 ②(PO 05:22Z · 유나) — 회고 종합은 이제 작업이라 오래 걸릴 수 있다. 10초 넘게 기다리면 로딩 아래 «창을 닫아도 계속 처리돼요» ·
// 10초 전엔 없음 · 끝나면(성공 · 실패) 줄째 사라짐.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { SprintCloseCockpit } from './sprint-close-cockpit';
import { SLOW_JOB_NOTICE_MS } from '@/lib/background-job';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentMemberType: 'human' }) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { act(() => { root.unmount(); }); container.remove(); vi.useRealTimers(); });

function mount(onGenerateSynthesis: () => Promise<boolean>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <SprintCloseCockpit hypotheses={[]} synthesis={null} nextHypotheses={[]} onGenerateSynthesis={onGenerateSynthesis} onAdoptRecommendation={async () => false} />
      </NextIntlClientProvider>,
    );
  });
}

describe('SprintCloseCockpit — 종합 작업 대기 줄(#4336 PR2 ②)', () => {
  it('⭐10초 전엔 없음 · 넘으면 «창을 닫아도 계속 처리돼요» · 끝나면 사라짐(실패면 실패 문장)', async () => {
    let finish: (ok: boolean) => void = () => {};
    mount(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const cta = [...container.querySelectorAll('button')].find((b) => b.textContent === '종합 생성');
    await act(async () => { cta!.click(); });

    await act(async () => { vi.advanceTimersByTime(SLOW_JOB_NOTICE_MS - 1); });
    expect(container.textContent).not.toContain('창을 닫아도 계속 처리돼요');
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(container.textContent).toContain('창을 닫아도 계속 처리돼요');
    expect([...container.querySelectorAll('p')].find((p) => p.textContent?.includes('창을 닫아도'))?.classList.contains('break-keep')).toBe(true);

    await act(async () => { finish(false); });
    expect(container.textContent).not.toContain('창을 닫아도 계속 처리돼요');
    expect(container.textContent).toContain('종합 생성에 실패했어요');
  });
});
