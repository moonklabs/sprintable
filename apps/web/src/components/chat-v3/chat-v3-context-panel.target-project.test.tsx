// @vitest-environment jsdom
// story #4314 — v3 문맥 패널의 «기준»(대화에 이어진 작업 항목) 링크는 **그 대화의 프로젝트**를 싣는다. v3는 알림 · 링크 · 딥링크로 다른 프로젝트
// 대화도 id로 연다(`GET /api/v2/conversations/{id}`는 조직만 거름) — 예전엔 늘 현재 p라 틀린 셸에 착지했다. 대화 프로젝트를 모를 때만 현재 p.
// 현재 p(CUR)와 대화 p(proj-b)를 다르게 둬 값으로 가른다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => `${h}${h.includes('?') ? '&' : '?'}p=CUR` }));

import { ChatV3ContextPanel } from './chat-v3-context-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/activity-logs')) {
      return { ok: true, status: 200, json: async () => ({ data: { items: [{ id: 'l1', actor_name: '페드루', action: 'story_created', entity_title: '결재 항목', created_at: new Date().toISOString(), context: {} }] } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function mount(conversationProjectId: string | null | undefined) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatV3ContextPanel
          conversationId="conv-1"
          conversationProjectId={conversationProjectId}
          openArtifactId={null}
          workItemRef={{ type: 'story', id: 's1' }}
          needsMe={[]}
          todayV3Enabled
          todayHref="/today"
        />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const scopeHref = () => container.querySelector('[data-testid="chat-v3-context-scope"]')?.getAttribute('href');

describe('ChatV3ContextPanel — «기준» 링크의 대상 프로젝트(story #4314)', () => {
  it('⭐다른 프로젝트 대화(현재 p = CUR · 대화 p = proj-b) — 작업 항목 링크는 대화 프로젝트 `?p=proj-b` · 현재 p 0', async () => {
    await mount('proj-b');
    expect(scopeHref()).toBe('/board?story=s1&p=proj-b');
    expect(scopeHref()).not.toContain('CUR');
  });

  it('대화 프로젝트를 모르면(옛 응답 · 값 없음) 현재 p 폴백', async () => {
    await mount(null);
    expect(scopeHref()).toBe('/board?story=s1&p=CUR');
    await mount(undefined);
    expect(scopeHref()).toBe('/board?story=s1&p=CUR');
  });
});
