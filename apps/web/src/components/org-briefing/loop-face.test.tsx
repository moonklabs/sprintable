// @vitest-environment jsdom
//
// story 6b707960 — LoopFace 왕복 검증: 2 BFF(hypotheses·dashboard/overview) 조합이 실제로 검증중/달성/
// 배움/다음루프 행으로 렌더되는지, falsified가 destructive(빨강) 클래스 없이 렌더되는지(soul-lock)
// 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { LoopFace } from './loop-face';
import koMessages from '../../../messages/ko.json';

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
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function stubFetch(hypotheses: unknown, overview: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/hypotheses')) return { ok: true, json: async () => hypotheses };
    if (url.includes('/api/dashboard/overview')) return { ok: true, json: async () => overview };
    return { ok: false, json: async () => null };
  }));
}

async function mount() {
  await act(async () => { root.render(wrap(<LoopFace projectId="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('LoopFace', () => {
  it('renders testing/achieved/learning/next rows from the combined hypotheses+overview BFFs', async () => {
    stubFetch(
      {
        data: [
          { id: 'h1', status: 'active', statement: '보이는 의도가 신뢰를 앞당긴다', epic_ids: ['e1'], created_at: '2026-07-01T00:00:00Z' },
          { id: 'h2', status: 'verified', statement: '달성된 가설', epic_ids: [], created_at: '2026-07-01T00:00:00Z' },
          { id: 'h3', status: 'falsified', statement: '반증된 가설', epic_ids: [], created_at: '2026-07-01T00:00:00Z' },
          { id: 'h4', status: 'proposed', statement: '다음 가설', epic_ids: [], created_at: '2026-07-01T00:00:00Z' },
        ],
      },
      { data: { project_status: { epics: [{ epic_id: 'e1', title: 'E-CANVAS', completion_pct: 82, total: 11 }] } } },
    );
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('검증 중');
    expect(html).toContain('달성');
    expect(html).toContain('배움');
    expect(html).toContain('다음 실험');
    expect(html).toContain('E-CANVAS');
  });

  it('never renders a destructive/red utility class for a falsified (learning) hypothesis — soul-lock', async () => {
    stubFetch(
      { data: [{ id: 'h1', status: 'falsified', statement: '반증된 가설', epic_ids: [], created_at: '2026-07-01T00:00:00Z' }] },
      { data: { project_status: { epics: [] } } },
    );
    await mount();
    // 오르테가 리뷰 관찰① — 이전 버전은 공허 통과 어서션이었다: `data-variant="destructive"` 부재는
    // 코드가 실제로 info를 쓰기 때문에 트리비얼하게 항상 참이고, `text-red`는 이 디자인시스템이 애초에
    // 쓰지 않는 클래스명(destructive variant는 `text-destructive`)이라 실제 회귀가 나도 절대 안 걸린다
    // (27e339bc 공허-통과 테스트 버그 클래스). 양성 어서션(현재 올바른 info 클래스가 실제로 있다)과
    // 진짜 존재하는 위험 클래스명(text-destructive)에 대한 음성 어서션으로 교체 — variant가
    // destructive로 바뀌면 이 테스트가 실제로 실패한다.
    expect(container.innerHTML).toContain('text-info');
    expect(container.innerHTML).not.toContain('text-destructive');
  });

  it('excludes killed/archived hypotheses (forward-only) and renders the identity-forward empty state when nothing qualifies', async () => {
    stubFetch(
      { data: [{ id: 'h1', status: 'killed', statement: '중단된 가설', epic_ids: [], created_at: '2026-07-01T00:00:00Z' }] },
      { data: { project_status: { epics: [] } } },
    );
    await mount();
    // story 64b9a879: "없습니다" 부재형이 아니라 "~하면 여기 모입니다" 발견성 카피로 전환.
    expect(container.innerHTML).toContain('가설을 세우면 검증까지 이어지는 과정이 여기 모입니다');
    expect(container.innerHTML).not.toContain('중단된 가설');
  });

  it('빈상태에서 C1 학습 루프(/loops) 진입점이 gentle 텍스트 링크로 노출된다', async () => {
    stubFetch({ data: [] }, { data: { project_status: { epics: [] } } });
    await mount();
    const link = container.querySelector('a[href$="/loops"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('첫 가설 만들기');
  });

  it('타이틀 옆에 파란 dot(bg-info)이 렌더된다', async () => {
    stubFetch({ data: [] }, { data: { project_status: { epics: [] } } });
    await mount();
    expect(container.innerHTML).toContain('bg-info');
  });
});
