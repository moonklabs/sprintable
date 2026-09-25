// @vitest-environment jsdom
//
// 까심군 QA 회귀(2026-07-21) — /api/dispatch가 apiSuccess()로 {data:{dispatched,...}}를
// 감싸는데 패널이 flat({dispatched})으로 읽어 서버가 200 성공을 반환해도 매번 "담당자
// 미지정" 토스트가 떴다(4/4 재현, dispatched는 항상 undefined). RED→GREEN으로 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EntityDispatchPanel } from './entity-dispatch-panel';
import koMessages from '../../../messages/ko.json';
import { ToastProvider, ToastContainer, useToast } from '@/components/ui/toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// story #3759 — 이 컴포넌트가 useToast()로 공유 Context를 구독한다. 정적 import된
// 컴포넌트라(파일 상단) vi.resetModules()의 영향을 안 받는 이 파일 자체의 정적
// ToastProvider로 감싸면 된다(동적 재-import 처방 불요, content/page.test.tsx와 동형).
function TestToastRenderer() {
  const { toasts, dismissToast } = useToast();
  return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <ToastProvider>
        {node}
        <TestToastRenderer />
      </ToastProvider>
    </NextIntlClientProvider>
  );
}

const MEMBERS = [{ id: 'm1', name: '홍길동', type: 'human' as const, is_active: true }];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('EntityDispatchPanel — 까심군 QA 회귀 (envelope unwrap)', () => {
  it('/api/dispatch가 {data:{dispatched:true}}로 응답하면 성공 토스트가 뜬다(담당자 미지정 오탐 아님)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
      if (url === '/api/stories/s1') return { ok: true, json: async () => ({ data: {} }) };
      if (url === '/api/dispatch') {
        // 실제 서버 계약 — apiSuccess()가 감싼 shape 그대로.
        return { ok: true, json: async () => ({ data: { dispatched: true, assignee_id: 'm1', reason: 'ok' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(
        <EntityDispatchPanel entityType="story" entityId="s1" projectId="p1" currentAssigneeId="m1" />,
      ));
    });
    // 담당자 select가 members fetch 이후 채워질 때까지 한 틱 더.
    await act(async () => { await Promise.resolve(); });

    const dispatchBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('전달'));
    await act(async () => {
      dispatchBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('담당자가 지정되지 않았어요');
    expect(document.body.textContent).toContain('전달했어요');
  });

  it('/api/dispatch가 {data:{dispatched:false}}면(진짜 담당자 미지정) 안내 토스트가 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
      if (url === '/api/stories/s1') return { ok: true, json: async () => ({ data: {} }) };
      if (url === '/api/dispatch') {
        return { ok: true, json: async () => ({ data: { dispatched: false, reason: 'no_assignee' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(
        <EntityDispatchPanel entityType="story" entityId="s1" projectId="p1" currentAssigneeId="m1" />,
      ));
    });
    await act(async () => { await Promise.resolve(); });

    const dispatchBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('전달'));
    await act(async () => {
      dispatchBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('담당자가 지정되지 않았어요');
  });
});

// story #3997 CHANGES(페드루 PO 지적 2026-09-17) — 이 자리가 실은 진짜 "담당자 선택"
// (스토리·doc·에픽 배정+디스패치)이라 「시스템 발행」에게 배정·디스패치할 수 있던 결함.
describe('EntityDispatchPanel — 시스템 발행 제외(story #3997 CHANGES)', () => {
  it('⭐담당자 select에 「시스템 발행」이 안 뜨고 실 멤버는 그대로 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/members')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'm1', name: '홍길동', type: 'human', is_active: true },
              { id: 'sp1', name: '시스템 발행', type: 'agent', is_active: true, runtime_type: 'system-publisher' },
              { id: 'a1', name: '점검봇', type: 'agent', is_active: true, runtime_type: 'claude-code' },
            ],
          }),
        };
      }
      if (url === '/api/stories/s1') return { ok: true, json: async () => ({ data: {} }) };
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(
        <EntityDispatchPanel entityType="story" entityId="s1" projectId="p1" currentAssigneeId={null} />,
      ));
    });
    await act(async () => { await Promise.resolve(); });

    const options = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(options.some((t) => t?.includes('시스템 발행'))).toBe(false);
    expect(options.some((t) => t?.includes('홍길동'))).toBe(true);
    expect(options.some((t) => t?.includes('점검봇'))).toBe(true);
  });
  it('⭐story #4311 — 담당자 select 행 라벨은 memberRowLabels로 · 이름 없는 둘이면 서로 갈린다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/members')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'aaaaaaaa-1', name: null, type: 'human', is_active: true },
              { id: 'bbbbbbbb-2', name: null, type: 'human', is_active: true },
            ],
          }),
        };
      }
      if (url === '/api/stories/s1') return { ok: true, json: async () => ({ data: {} }) };
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(
        <EntityDispatchPanel entityType="story" entityId="s1" projectId="p1" currentAssigneeId={null} />,
      ));
    });
    await act(async () => { await Promise.resolve(); });

    const options = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toContain(`${koMessages.common.memberUnnamed} · aaaaaaaa`);
    expect(options).toContain(`${koMessages.common.memberUnnamed} · bbbbbbbb`);
  });

  it('⭐story #4311 — 담당자 select 행 라벨은 memberRowLabels로 · 동명이인도 서로 갈린다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/members')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'aaaaaaaa-1', name: '송윤재', type: 'human', is_active: true },
              { id: 'bbbbbbbb-2', name: '송윤재', type: 'human', is_active: true },
            ],
          }),
        };
      }
      if (url === '/api/stories/s1') return { ok: true, json: async () => ({ data: {} }) };
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => {
      root.render(wrap(
        <EntityDispatchPanel entityType="story" entityId="s1" projectId="p1" currentAssigneeId={null} />,
      ));
    });
    await act(async () => { await Promise.resolve(); });

    const options = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toContain('송윤재 · aaaaaaaa');
    expect(options).toContain('송윤재 · bbbbbbbb');
  });
});

// story #3007(로드맵 P2·PR-E, L1) — "더보기" 드롭다운은 floating이라 --elev-overlay.
describe('EntityDispatchPanel — 로드맵 P2·PR-E L1(더보기 드롭다운 elevation 토큰)', () => {
  it('더보기 드롭다운이 shadow-[var(--elev-overlay)]를 쓰고 shadow-md는 안 쓴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
      if (url === '/api/stories/s1') return { ok: true, json: async () => ({ data: {} }) };
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => {
      root.render(wrap(
        <EntityDispatchPanel entityType="story" entityId="s1" projectId="p1" currentAssigneeId="m1" mobileMode="assignee-only" />,
      ));
    });
    await act(async () => { await Promise.resolve(); });

    const moreBtn = container.querySelector('button[aria-label="더보기"]') as HTMLButtonElement;
    await act(async () => { moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const dropdown = container.querySelector('.shadow-\\[var\\(--elev-overlay\\)\\]');
    expect(dropdown).not.toBeNull();
    expect(container.querySelector('.shadow-md')).toBeNull();
  });
});
