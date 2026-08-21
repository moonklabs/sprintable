// @vitest-environment jsdom
//
// story #2889(S2h①③)·S2d(미르코) — gate는 reference_registry TARGET_ONLY라
// RICH_PREVIEW_TYPES/ENTITY_API/getEntityHref(parity 대상)엔 못 들어간다. EntityPreviewModal
// 안에 독립 gate 분기(fetch·href·renderGateSummary)를 추가했다 — 여기는 그 분기의 회귀가드.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EntityPreviewModal } from './embed-card';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetchWithAuth(impl: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>) {
  vi.stubGlobal('fetch', vi.fn((url: string) => impl(url)));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('EntityPreviewModal gate 분기 — story #2889/S2d', () => {
  it('/api/gates/{id}를 fetch해 title·gate_type·risk 배지를 렌더한다', async () => {
    stubFetchWithAuth(async (url) => {
      expect(url).toBe('/api/gates/g-1');
      return {
        ok: true,
        json: async () => ({
          data: {
            id: 'g-1', status: 'pending', gate_type: 'merge', risk_grade: 'high',
            work_item_summary: { title: 'PR#42 병합 게이트', slug: null }, work_item_id: 'wi-1',
          },
        }),
      };
    });
    await act(async () => {
      root.render(
        <EntityPreviewModal entityType="gate" entityId="g-1" title={null} status={null} href={null} onClose={() => {}} embedded />,
      );
    });
    await flush();
    expect(container.textContent).toContain('PR#42 병합 게이트');
    expect(container.textContent).toContain('merge');
    expect(container.textContent).toContain('High risk');
  });

  it('전체 보기 링크가 /gates/{id}로 향한다(own-href, parity getEntityHref 무관)', async () => {
    stubFetchWithAuth(async () => ({
      ok: true,
      json: async () => ({ data: { id: 'g-2', status: 'pending', gate_type: 'doc_approval', risk_grade: 'low' } }),
    }));
    await act(async () => {
      root.render(
        <EntityPreviewModal entityType="gate" entityId="g-2" title={null} status={null} href={null} onClose={() => {}} embedded />,
      );
    });
    await flush();
    const link = container.querySelector('a[href="/gates/g-2"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('전체 보기');
  });

  it('fetch 실패 시 "대상을 찾을 수 없습니다"로 정직하게 떨어진다(무한 스피너 금지)', async () => {
    stubFetchWithAuth(async () => ({ ok: false, json: async () => ({}) }));
    await act(async () => {
      root.render(
        <EntityPreviewModal entityType="gate" entityId="g-3" title={null} status={null} href={null} onClose={() => {}} embedded />,
      );
    });
    await flush();
    expect(container.textContent).toContain('대상을 찾을 수 없습니다');
  });
});
