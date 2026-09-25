// @vitest-environment jsdom
// story #4231 3차(b) — 헬퍼(필수 withProject)·훅이 flat 목적지에 프로젝트(`?p=`)를 싣는지. 워크스페이스 경로(보드)는 그대로.
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { toExceptionQueueItems, type BeAttentionSignal, type ExceptionLabels } from '@/components/glance/derive-exception-signals';
import { resolveDeeplinkHref } from '@/lib/storage/format';
import { useChatsHref, useConnectRulesHref } from '@/app/dashboard/dashboard-shell';
import { setPendingProjectTarget } from '@/lib/pending-project-switch';
import type { AssetSourceLink } from '@/lib/storage/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const addP = (href: string) => `${href}${href.includes('?') ? '&' : '?'}p=proj-A`;

afterEach(() => { setPendingProjectTarget(null); });

describe('헬퍼 — withProject(필수)로 flat 목적지만 싣는다', () => {
  it('예외 스트림: 결재 대기 → 결재함 `?p=` · 스토리 신호 → 보드도 `?p=`(#4231 4차)', () => {
    const labels = { kind: {}, action: {} } as unknown as ExceptionLabels;
    const signals = [
      { kind: 'gate_pending', story_id: null, title: 'g', ref: { approval_id: 'ap1' } },
      { kind: 'blocked', story_id: 's1', title: 'b', ref: {} },
    ] as unknown as BeAttentionSignal[];
    const hrefs = toExceptionQueueItems(signals, labels, addP).map((i) => i.href);
    expect(hrefs).toContain('/inbox?tab=gates&p=proj-A');
    expect(hrefs).toContain('/flow?story=s1&p=proj-A'); // #4231 4차 — 보드(옛 자원 경로)도 flat · 흐름 화면의 현재 프로젝트
  });

  it('저장소 출처 딥링크: 대화 · 문서 · 스토리(보드) 모두 `?p=`(#4231 4차)', () => {
    const link = (deeplink: unknown) => ({ type: 'auto', deeplink }) as unknown as AssetSourceLink;
    expect(resolveDeeplinkHref(link({ conversation_id: 'c1', message_id: 'm1' }), addP)).toBe('/chats/c1?messageId=m1&p=proj-A');
    expect(resolveDeeplinkHref(link({ conversation_id: 'c1' }), addP)).toBe('/chats/c1?p=proj-A');
    expect(resolveDeeplinkHref(link({ doc_slug: 'guide' }), addP)).toBe('/docs/guide?p=proj-A');
    expect(resolveDeeplinkHref(link({ story_id: 's1' }), addP)).toBe('/flow?story=s1&p=proj-A'); // #4231 4차
  });
});

describe('훅 — useChatsHref · useConnectRulesHref가 목적지에 프로젝트를 싣는다(전환 대기 목표 우선)', () => {
  it('전환 대기 중 목표 proj-B를 싣는다', async () => {
    setPendingProjectTarget('proj-B');
    function Probe() {
      return <span data-chats={useChatsHref()} data-rules={useConnectRulesHref('/organization/channels')} />;
    }
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => { root.render(<Probe />); });
    expect(el.querySelector('span')?.getAttribute('data-chats')).toBe('/chats?p=proj-B');
    expect(el.querySelector('span')?.getAttribute('data-rules')).toBe('/organization/channels?p=proj-B');
    await act(async () => { root.unmount(); });
  });
});
