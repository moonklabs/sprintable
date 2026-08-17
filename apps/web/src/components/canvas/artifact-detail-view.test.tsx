// @vitest-environment jsdom
//
// story #2713 — standalone 아티팩트 상세 진입점 회귀가드. storyId 없이 단건 fetch만으로
// ArtifactViewer가 뜨는지(양성)와, 존재하지 않는/접근 불가 id면 not-found 상태로 빠지는지
// (음성) 둘 다 확認 — ArtifactSection의 story-scoped 로더를 재사용하는 것이라 로더 자체의
// 정상/에러 분기 로직은 artifact-section.test.tsx가 이미 커버, 여기선 "storyId 없이도
// 뜬다"는 이 컴포넌트 고유의 결합만 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ArtifactDetailView } from './artifact-detail-view';
import koMessagesRaw from '../../../messages/ko.json';

type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.clearAllMocks();
});

async function mount(artifactId: string) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ArtifactDetailView artifactId={artifactId} />
      </NextIntlClientProvider>,
    );
  });
  // detail → (comments·versions·pins·gates) 순차 fetch 체인 플러시.
  await act(async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await Promise.resolve(); await Promise.resolve();
  });
}

function stubFetch(detailOk: boolean) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/pins')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    // story #2721(별건, 이번 판 사이 develop에 머지) — ArtifactViewer가 이제 EntityBacklinksSection도
    // 그려 `/backlinks`를 fetch한다. `/comments`보다 먼저 걸러야 한다(문자열 포함 검사라 순서 무관하지만
    // 명시적으로 분리 — items 배열 형상 계약이 detail 폴백과 달라 섞이면 items.filter 크래시).
    if (url.includes('/backlinks')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('/comments')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('/versions')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('/api/gates')) return { ok: true, status: 200, json: async () => [] };
    // 단건 상세 — storyId/epic_id/doc_id 전부 null(standalone, 이 스토리의 핵심 실증 대상).
    if (!detailOk) return { ok: false, status: 404, json: async () => ({}) };
    return {
      ok: true, status: 200,
      json: async () => ({
        data: {
          id: 'artifact-1', title: '흐름판 재설계 시안', story_id: null, epic_id: null, doc_id: null,
          source: 'created', latest_version_number: 1, anchor_version: null, created_by: null,
          created_at: '2026-08-17T00:00:00Z', version_number: 1, version_summary: null, nodes: [],
        },
      }),
    };
  }) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal('fetch', fetchMock);
}

describe('ArtifactDetailView — standalone 상세(story #2713)', () => {
  it('storyId 없이 artifactId만으로 ArtifactViewer가 뜬다(양성)', async () => {
    stubFetch(true);
    await mount('artifact-1');
    expect(container.textContent).toContain('흐름판 재설계 시안');
    expect(container.textContent).toContain('갤러리로 돌아가기');
  });

  it('404(미존재/접근 불가)면 not-found 상태로 빠진다 — existence-non-disclosure 그대로 상속', async () => {
    stubFetch(false);
    await mount('artifact-missing');
    expect(container.textContent).toContain('산출물을 찾을 수 없습니다');
    expect(container.textContent).not.toContain('갤러리로 돌아가기');
  });
});
