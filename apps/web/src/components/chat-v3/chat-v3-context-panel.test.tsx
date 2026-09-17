// @vitest-environment jsdom
//
// story #3972 — 맥락 패널 「관련」(오늘 스냅샷 역조회, BE 0 — needsMe는 부모가 공유
// 캐시로 넘겨준다)·「열린 산출물」(openArtifactId prop 있을 때만 fetch) 단위 테스트.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatV3ContextPanel } from './chat-v3-context-panel';
import type { TodayNeedsMeItem } from '@/components/org-briefing/derive-today';

const fetchMock = vi.fn();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: null }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const needsMeItem: TodayNeedsMeItem = {
  id: 'g1', source: 'gate', state: 'signature',
  workItemType: 'channel_post', workItemId: 'w1', workItemTitle: '발행',
  requestedByName: null, reason: null, createdAt: '2026-09-16T00:00:00Z', conversationId: 'conv-1',
};

describe('ChatV3ContextPanel — 관련(오늘 스냅샷 역조회)', () => {
  it('⭐conversationId가 needsMe[].conversationId와 일치하면 관련 링크가 뜬다', async () => {
    await act(async () => {
      root.render(wrap(<ChatV3ContextPanel conversationId="conv-1" openArtifactId={null} workItemRef={null} needsMe={[needsMeItem]} todayV3Enabled />));
    });
    const link = container.querySelector('[data-testid="chat-v3-related-today-link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/today');
  });

  it('일치하는 needsMe가 없으면 관련은 빈 상태 문구', async () => {
    await act(async () => {
      root.render(wrap(<ChatV3ContextPanel conversationId="conv-2" openArtifactId={null} workItemRef={null} needsMe={[needsMeItem]} todayV3Enabled />));
    });
    expect(container.querySelector('[data-testid="chat-v3-related-today-link"]')).toBeNull();
  });

  // story #3972 CHANGES(페드루 PO 2026-09-17 01:54Z, 실결함) — TODAY_V3_ENABLED
  // OFF면 /today가 404라 옛 큐(/inbox)로 보낸다.
  it('⭐todayV3Enabled=false면 관련 링크가 /inbox로 간다(404 방지)', async () => {
    await act(async () => {
      root.render(wrap(<ChatV3ContextPanel conversationId="conv-1" openArtifactId={null} workItemRef={null} needsMe={[needsMeItem]} todayV3Enabled={false} />));
    });
    expect(container.querySelector('[data-testid="chat-v3-related-today-link"]')?.getAttribute('href')).toBe('/inbox');
  });
});

// story #3990(E-UX-OVERHAUL·「대화」 구현 5/N) — 「근거」·「이력」 실값(#3971 부재 4·5
// 정정으로 기존 evidence·activity-logs API를 workItemRef로 그대로 부른다, 새 BE 0).
async function mountWithWorkItem(
  workItemRef: { type: 'story' | 'task'; id: string } | null,
  extra: { evidence?: unknown; evidenceStatus?: number; history?: unknown; historyStatus?: number } = {},
) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/evidence')) {
      return { ok: (extra.evidenceStatus ?? 200) < 300, status: extra.evidenceStatus ?? 200, json: async () => ({ data: extra.evidence ?? [] }) };
    }
    if (url.startsWith('/api/activity-logs')) {
      return { ok: (extra.historyStatus ?? 200) < 300, status: extra.historyStatus ?? 200, json: async () => ({ data: { items: extra.history ?? [] } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: null }) };
  });
  await act(async () => {
    root.render(wrap(
      <ChatV3ContextPanel conversationId="conv-1" openArtifactId={null} workItemRef={workItemRef} needsMe={[]} todayV3Enabled />,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ChatV3ContextPanel — 근거·이력(story #3990, work-item 스코프)', () => {
  it('⭐workItemRef=null이면 두 절 다 「이 대화에 이어진 일이 없어요」·evidence/activity-logs 콜 자체가 0(AC5 콜 예산)', async () => {
    await mountWithWorkItem(null);
    expect(container.querySelector('[data-testid="chat-v3-evidence-no-work-item"]')?.textContent).toBe('이 대화에 이어진 일이 없어요');
    expect(container.querySelector('[data-testid="chat-v3-history-no-work-item"]')?.textContent).toBe('이 대화에 이어진 일이 없어요');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith('/api/evidence'))).toBe(false);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith('/api/activity-logs'))).toBe(false);
  });

  it('⭐workItemRef가 있으면 work_item_id/work_item_type·entity_type/entity_id로 조회한다', async () => {
    await mountWithWorkItem({ type: 'story', id: 's1' });
    const evidenceCall = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/evidence'));
    const historyCall = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/activity-logs'));
    expect(evidenceCall?.[0]).toBe('/api/evidence?work_item_id=s1&work_item_type=story');
    expect(historyCall?.[0]).toBe('/api/activity-logs?entity_type=story&entity_id=s1');
  });

  it('근거 0건이면 「아직 없어요」(구조 사실 문구와 다르다)', async () => {
    await mountWithWorkItem({ type: 'story', id: 's1' }, { evidence: [] });
    expect(container.querySelector('[data-testid="chat-v3-evidence-empty"]')?.textContent).toBe('아직 없어요');
  });

  it('⭐근거 목록 — 유형 라벨(verify 네임스페이스 재사용)+링크형 ref는 열 수 있는 링크로', async () => {
    await mountWithWorkItem({ type: 'story', id: 's1' }, {
      evidence: [{ id: 'e1', type: 'pr', ref: 'https://github.com/x/y/pull/1', note: 'PR 링크', source: null, created_by: null, created_at: '2026-09-16T00:00:00Z', org_id: 'o1', work_item_id: 's1', work_item_type: 'story', artifact_version_id: null, artifact_id: null, artifact_version_number: null }],
    });
    const list = container.querySelector('[data-testid="chat-v3-evidence-list"]');
    expect(list?.textContent).toContain('PR');
    const link = list?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://github.com/x/y/pull/1');
    expect(link?.textContent).toBe('PR 링크');
  });

  // CHANGES-1(페드루 PO 판정 2026-09-17 04:37Z) — 긴 note(예 3984 AC6 evidence
  // ~1500자·여러 줄)가 inline truncate라 안 먹혀 패널에 통째로 쏟아지던 결함.
  // block+min-w-0(evidence-section.tsx 기존 처방)로 한 줄 표시+title로 전문 보관.
  it('⭐근거 목록 — 긴 note는 truncate 대상(block)에 담기고 title 속성에 전문이 남는다', async () => {
    const longNote = 'A'.repeat(1500);
    await mountWithWorkItem({ type: 'story', id: 's1' }, {
      evidence: [{ id: 'e1', type: 'url', ref: 'https://x.dev', note: longNote, source: null, created_by: null, created_at: '2026-09-16T00:00:00Z', org_id: 'o1', work_item_id: 's1', work_item_type: 'story', artifact_version_id: null, artifact_id: null, artifact_version_number: null }],
    });
    const link = container.querySelector('[data-testid="chat-v3-evidence-list"] a') as HTMLAnchorElement;
    expect(link.className).toContain('truncate');
    expect(link.className).toContain('block');
    expect(link.parentElement?.className).toContain('min-w-0');
    expect(link.getAttribute('title')).toBe(longNote);
  });

  it('⭐근거 실패 — 보이는 오류+「다시 시도」, 성공으로 바뀐 뒤 클릭하면 목록이 뜬다', async () => {
    let evidenceStatus = 500;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/evidence')) {
        return evidenceStatus === 500
          ? { ok: false, status: 500, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => ({ data: [{ id: 'e1', type: 'url', ref: 'https://x.dev', note: null, source: null, created_by: null, created_at: '2026-09-16T00:00:00Z', org_id: 'o1', work_item_id: 's1', work_item_type: 'story', artifact_version_id: null, artifact_id: null, artifact_version_number: null }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
    });
    await act(async () => {
      root.render(wrap(<ChatV3ContextPanel conversationId="conv-1" openArtifactId={null} workItemRef={{ type: 'story', id: 's1' }} needsMe={[]} todayV3Enabled />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="chat-v3-evidence-error"]')?.textContent).toContain('근거를 불러오지 못했어요');
    evidenceStatus = 200;
    const retryBtn = container.querySelector('[data-testid="chat-v3-evidence-retry"]') as HTMLElement;
    await act(async () => { retryBtn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="chat-v3-evidence-list"]')).not.toBeNull();
  });

  it('⭐이력 목록 — 상태 전후는 SSOT 라벨로 「상태를 X → Y로」, 필드는 4373과 같은 낱말 재사용', async () => {
    await mountWithWorkItem({ type: 'story', id: 's1' }, {
      history: [
        { id: 'l1', actor_name: '페드루', action: 'story_created', entity_title: '제목', created_at: new Date().toISOString(), context: {} },
        { id: 'l2', actor_name: '유나', action: 'story_updated', entity_title: '제목', created_at: new Date().toISOString(), context: { fields: ['title'] } },
      ],
    });
    const list = container.querySelector('[data-testid="chat-v3-history-list"]');
    expect(list?.textContent).toContain('페드루가 만들었어요');
    expect(list?.textContent).toContain('유나가 제목을 바꿨어요');
  });

  it('⭐이력 실패 — 보이는 오류+「다시 시도」', async () => {
    await mountWithWorkItem({ type: 'story', id: 's1' }, { historyStatus: 500 });
    expect(container.querySelector('[data-testid="chat-v3-history-error"]')?.textContent).toContain('이력을 불러오지 못했어요');
    expect(container.querySelector('[data-testid="chat-v3-history-retry"]')).not.toBeNull();
  });

  it('⭐「기준」 줄 — 이력 응답의 entity_title로 스토리 링크(/board?story=)를 만든다(제 3의 콜 0)', async () => {
    await mountWithWorkItem({ type: 'story', id: 's1' }, {
      history: [{ id: 'l1', actor_name: '페드루', action: 'story_created', entity_title: '결재 항목 채팅', created_at: new Date().toISOString(), context: {} }],
    });
    const scope = container.querySelector('[data-testid="chat-v3-context-scope"]');
    expect(scope?.textContent).toBe('결재 항목 채팅 기준');
    expect(scope?.getAttribute('href')).toBe('/board?story=s1');
  });

  // CHANGES-2(페드루 PO 판정 2026-09-17 04:37Z·유나 확定 04:42Z) — 제목 출처가 없어도
  // getEntityHref는 링크되니 줄 자체는 유지, 라벨만 「이어진 일 열기」로 대체한다.
  it('⭐이력이 0건이면(제목 출처 없음) 「기준」줄이 사라지지 않고 「이어진 일 열기」로 링크는 유지된다', async () => {
    await mountWithWorkItem({ type: 'story', id: 's1' }, { history: [] });
    const scope = container.querySelector('[data-testid="chat-v3-context-scope"]');
    expect(scope?.textContent).toBe('이어진 일 열기');
    expect(scope?.getAttribute('href')).toBe('/board?story=s1');
  });

  it('workItemRef가 없으면(이어진 일 자체가 없음) 「기준」 줄이 안 뜬다', async () => {
    await mountWithWorkItem(null);
    expect(container.querySelector('[data-testid="chat-v3-context-scope"]')).toBeNull();
  });

  it('task 참조는 getEntityHref가 own-href 0(embed-card.tsx 기존 규약)이라 「기준」줄이 링크 없는 평문으로 뜬다', async () => {
    await mountWithWorkItem({ type: 'task', id: 't1' }, { history: [] });
    const scope = container.querySelector('[data-testid="chat-v3-context-scope"]');
    expect(scope?.textContent).toBe('이어진 일 열기');
    expect(scope?.tagName).toBe('P');
  });

  // CHANGES-1(4381)과 같은 클래스 — A work item 조회 中(지연) B로 옮기면 A의 늦은
  // 응답이 B 화면을 덮으면 안 된다.
  it('⭐work item A 응답이 늦게 도착해도 그 사이 옮겨간 work item B 화면을 덮지 않는다', async () => {
    let resolveA: (v: unknown) => void = () => {};
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/evidence?work_item_id=a1&work_item_type=story') {
        return new Promise((r) => { resolveA = r; });
      }
      if (url === '/api/evidence?work_item_id=b1&work_item_type=story') {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'eb', type: 'url', ref: 'https://b.dev', note: 'B글', source: null, created_by: null, created_at: '2026-09-16T00:00:00Z', org_id: 'o1', work_item_id: 'b1', work_item_type: 'story', artifact_version_id: null, artifact_id: null, artifact_version_number: null }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
    });
    await act(async () => {
      root.render(wrap(<ChatV3ContextPanel conversationId="conv-1" openArtifactId={null} workItemRef={{ type: 'story', id: 'a1' }} needsMe={[]} todayV3Enabled />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="chat-v3-evidence-loading"]')).not.toBeNull();

    await act(async () => {
      root.render(wrap(<ChatV3ContextPanel conversationId="conv-1" openArtifactId={null} workItemRef={{ type: 'story', id: 'b1' }} needsMe={[]} todayV3Enabled />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="chat-v3-evidence-list"]')?.textContent).toContain('B글');

    await act(async () => {
      resolveA({ ok: true, status: 200, json: async () => ({ data: [{ id: 'ea', type: 'url', ref: 'https://a.dev', note: 'A글', source: null, created_by: null, created_at: '2026-09-16T00:00:00Z', org_id: 'o1', work_item_id: 'a1', work_item_type: 'story', artifact_version_id: null, artifact_id: null, artifact_version_number: null }] }) });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    const list = container.querySelector('[data-testid="chat-v3-evidence-list"]');
    expect(list?.textContent).toContain('B글');
    expect(list?.textContent).not.toContain('A글');
  });
});
