// @vitest-environment jsdom
//
// story #2905(S2c①) — EmbedCard artifact/mockup 실 렌더 인라인 폼 회귀가드. ArtifactThumbnail
// 자체(PNG export·canvas 렌더)는 별도 테스트 대상 — 여기는 EmbedCard의 fetch→분기 로직만.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EmbedCard } from './embed-card';

vi.mock('@/components/canvas/artifact-thumbnail', () => ({
  ArtifactThumbnail: ({ artifactId, latestVersionNumber }: { artifactId: string; latestVersionNumber: number }) => (
    <div data-testid="artifact-thumbnail" data-artifact-id={artifactId} data-version={latestVersionNumber} />
  ),
}));

const pushMock = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('EmbedCard artifact 실 렌더 인라인 — story #2905 S2c①', () => {
  it('artifact detail fetch 성공(latest_version_number 있음) → ArtifactThumbnail 렌더', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('/api/visual-artifacts/art-1');
      return { ok: true, json: async () => ({ data: { latest_version_number: 3, anchor_version: 2 } }) };
    }));
    await act(async () => {
      root.render(<EmbedCard entity_type="artifact" entity_id="art-1" title="목업 초안" status={null} />);
    });
    await flush();
    const thumb = container.querySelector('[data-testid="artifact-thumbnail"]');
    expect(thumb).not.toBeNull();
    expect(thumb?.getAttribute('data-artifact-id')).toBe('art-1');
    expect(thumb?.getAttribute('data-version')).toBe('3');
    expect(container.textContent).toContain('목업 초안');
  });

  it('fetch 실패 시 기존 아이콘+라벨 폼으로 정직하게 폴백(빈 썸네일 거짓 금지)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    await act(async () => {
      root.render(<EmbedCard entity_type="artifact" entity_id="art-2" title="깨진 아티팩트" status={null} />);
    });
    await flush();
    expect(container.querySelector('[data-testid="artifact-thumbnail"]')).toBeNull();
    expect(container.textContent).toContain('깨진 아티팩트');
  });

  it('story 타입은 이 분기와 무관 — 기존 아이콘+라벨+상태 폼 그대로(회귀 0)', async () => {
    await act(async () => {
      root.render(<EmbedCard entity_type="story" entity_id="s-1" title="일반 스토리" status="in-progress" />);
    });
    await flush();
    expect(container.querySelector('[data-testid="artifact-thumbnail"]')).toBeNull();
    expect(container.textContent).toContain('일반 스토리');
  });
});
