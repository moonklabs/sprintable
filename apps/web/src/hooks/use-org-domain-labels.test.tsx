// @vitest-environment jsdom
//
// story #3287([도메인탈고정·축1 Phase1] AC4 FE 소비) — useOrgDomainLabels가 GET
// /api/v2/organizations/{orgId}/domain-labels 응답을 domain:canonical_slug 키로 인덱싱해
// statusLabel()/entityTypeLabel()로 조회 가능케 하는지, 로케일 선택(ko 우선, 없으면 en
// 폴백)과 "오버라이드 미설정 slug는 undefined"(호출부가 canonical 문구로 폴백)를 실 렌더로
// 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useOrgDomainLabels } from './use-org-domain-labels';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function Harness({ orgId, locale }: { orgId: string | undefined; locale: string }) {
  const labels = useOrgDomainLabels(orgId, locale);
  return (
    <div
      data-testid="dump"
      data-loading={String(labels.loading)}
      data-status-backlog={labels.statusLabel('backlog') ?? ''}
      data-status-done={labels.statusLabel('done') ?? ''}
      data-entity-story={labels.entityTypeLabel('story') ?? ''}
    />
  );
}

async function flush(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

describe('useOrgDomainLabels — 라벨 API 인덱싱+로케일 선택(#3287 AC4)', () => {
  it('설정된 slug는 오버라이드 라벨을, 미설정 slug는 undefined를 반환한다', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { domain: 'status', canonical_slug: 'backlog', label_ko: '아이디어', label_en: 'Idea' },
        { domain: 'entity_type', canonical_slug: 'story', label_ko: '캠페인', label_en: 'Campaign' },
      ],
    });

    await act(async () => {
      root.render(<Harness orgId="org-1" locale="ko" />);
    });
    await flush();

    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/api/v2/organizations/org-1/domain-labels');
    expect(el.dataset.statusBacklog).toBe('아이디어');
    expect(el.dataset.statusDone).toBe(''); // 오버라이드 미설정 — undefined(호출부가 canonical 문구로 폴백)
    expect(el.dataset.entityStory).toBe('캠페인');
  });

  it('locale=en이면 label_en을 우선하고, label_en이 비어있으면 label_ko로 폴백한다', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { domain: 'status', canonical_slug: 'backlog', label_ko: '아이디어', label_en: 'Idea' },
        { domain: 'status', canonical_slug: 'done', label_ko: '완료', label_en: null },
      ],
    });

    await act(async () => {
      root.render(<Harness orgId="org-1" locale="en" />);
    });
    await flush();

    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(el.dataset.statusBacklog).toBe('Idea');
    expect(el.dataset.statusDone).toBe('완료'); // en 없음 → ko 폴백
  });

  it('orgId가 없으면 fetch 자체를 호출하지 않고(불필요 네트워크 0) 전부 undefined다', async () => {
    await act(async () => {
      root.render(<Harness orgId={undefined} locale="ko" />);
    });
    await flush();

    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(el.dataset.statusBacklog).toBe('');
    expect(el.dataset.loading).toBe('false');
  });

  it('응답 !ok면 조용히 빈 목록으로 처리한다(캔버스 렌더 자체는 안 깨짐)', async () => {
    fetchWithAuthMock.mockResolvedValue({ ok: false, json: async () => { throw new Error('unused'); } });

    await act(async () => {
      root.render(<Harness orgId="org-1" locale="ko" />);
    });
    await flush();

    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(el.dataset.statusBacklog).toBe('');
  });
});
