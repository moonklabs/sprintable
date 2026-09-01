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

  // 유나 design:changes(PR#3687, 2026-09-01) — 빈 문자열("")은 null이 아니라서 예전
  // `preferred ?? entry.label_ko ?? entry.label_en`이 그대로 반환해 소비처의
  // `statusLabel(...) ?? t(...)` 폴백도 안 타 헤더/배지가 빈칸으로 렌더될 뻔했다.
  it('빈 문자열 라벨("")은 값이 아니라 undefined로 취급된다(canonical 폴백 트리거)', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { domain: 'status', canonical_slug: 'backlog', label_ko: '', label_en: 'Idea' },
        { domain: 'status', canonical_slug: 'done', label_ko: '   ', label_en: null },
      ],
    });

    await act(async () => {
      root.render(<Harness orgId="org-1" locale="ko" />);
    });
    await flush();

    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    // ko 우선인데 label_ko=""(빈 값) — label_en('Idea')로 폴백해야 한다(빈 문자열을
    // "설정된 라벨"로 오인해 그대로 반환하면 안 됨).
    expect(el.dataset.statusBacklog).toBe('Idea');
    // label_ko가 공백뿐이고 label_en도 없음 — 둘 다 무효라 완전히 undefined(canonical 폴백).
    expect(el.dataset.statusDone).toBe('');
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
