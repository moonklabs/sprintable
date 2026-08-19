// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { EvidenceSection, isLinkableRef } from './evidence-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('isLinkableRef', () => {
  it('treats http/https refs as linkable', () => {
    expect(isLinkableRef('https://github.com/moonklabs/sprintable/pull/1985')).toBe(true);
    expect(isLinkableRef('http://example.com')).toBe(true);
  });

  it('treats non-URL refs (e.g. a metric description) as non-linkable', () => {
    expect(isLinkableRef('conversion rate +4.2%')).toBe(false);
    expect(isLinkableRef('run-abc123-00208')).toBe(false);
  });
});

describe('EvidenceSection (SSR snapshot — §7 상태 매트릭스 + P0-04 Claimed-vs-Verified)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when selfReported is null (증거 0 = 행 미렌더, "증명 안 됨" 표기 금지)', () => {
    const markup = renderToStaticMarkup(
      wrap(<EvidenceSection workItemId="s1" workItemType="story" selfReported={null} humanVerified={null} humanVerifiedBy={null} humanVerifiedAt={null} />),
    );
    expect(markup).toBe('');
  });

  it('renders nothing when all fields are undefined (BE가 필드 자체를 안 내려도 안전한 폴백)', () => {
    const markup = renderToStaticMarkup(
      wrap(<EvidenceSection workItemId="s1" workItemType="story" selfReported={undefined} humanVerified={undefined} humanVerifiedBy={undefined} humanVerifiedAt={undefined} />),
    );
    expect(markup).toBe('');
  });

  it('renders the amber "claimed" row when self_reported is true but human_verified is not, without fetching evidence eagerly', () => {
    const markup = renderToStaticMarkup(
      wrap(<EvidenceSection workItemId="s1" workItemType="story" selfReported={true} humanVerified={null} humanVerifiedBy={null} humanVerifiedAt={null} />),
    );
    expect(markup).toContain('에이전트 주장');
    expect(markup).toContain('text-warning-strong');
    expect(markup).not.toContain('text-success');
    expect(markup).toContain('근거 보기');
    // 디디 BE 가이드: "근거 보기" 클릭 전엔 evidence 리스트를 부르지 않는다(카드마다 N+1 방지).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders the green "verified" row with the resolved human name when human_verified is true (거짓 green→amber 정정의 반대편 — 실제로 검증된 건 정확히 green)', () => {
    const markup = renderToStaticMarkup(
      wrap(
        <EvidenceSection
          workItemId="s1"
          workItemType="story"
          selfReported={true}
          humanVerified={true}
          humanVerifiedBy="member-1"
          humanVerifiedAt="2026-07-11T00:00:00Z"
          memberMap={{ 'member-1': { name: '김민서' } }}
        />,
      ),
    );
    expect(markup).toContain('김민서');
    expect(markup).toContain('text-success');
    expect(markup).not.toContain('에이전트 주장');
  });

  it('falls back to a short id + generic label when the verifier is not in memberMap (no-fiction — never invents a name)', () => {
    const markup = renderToStaticMarkup(
      wrap(
        <EvidenceSection
          workItemId="s1"
          workItemType="story"
          selfReported={true}
          humanVerified={true}
          humanVerifiedBy="deadbeef-0000-0000-0000-000000000000"
          humanVerifiedAt="2026-07-11T00:00:00Z"
          memberMap={{}}
        />,
      ),
    );
    expect(markup).toContain('deadbe');
    expect(markup).not.toContain('undefined');
  });
});

describe('EvidenceSection — 증거 연결 POST(긴급 정정 2026-07-28: 봉투 이중포장 회귀 방지)', () => {
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

  async function renderExpanded() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/evidence?')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <EvidenceSection workItemId="s1" workItemType="story" selfReported={true} humanVerified={null} humanVerifiedBy={null} humanVerifiedAt={null} />
        </NextIntlClientProvider>,
      );
    });
    // 근거 보기 클릭 → 펼침 + 증거 연결 폼 노출
    const toggleBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('근거 보기'));
    await act(async () => { toggleBtn!.click(); await Promise.resolve(); await Promise.resolve(); });
  }

  it('POST 응답이 raw 단건 객체(봉투 없음)면 정상적으로 목록에 반영된다(회귀 방지 본체)', async () => {
    await renderExpanded();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        // BE create_evidence 실제 응답 — 봉투 없는 raw 단건 객체(오늘 curl로 실측한 형상).
        return new Response(JSON.stringify({
          id: 'ev-1', org_id: 'org-1', work_item_id: 's1', work_item_type: 'story',
          type: 'url', ref: 'https://example.com/proof', source: null, note: null,
          created_by: 'member-1', created_at: '2026-07-28T00:00:00Z',
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));

    const findEvidenceAddBtn = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '증거 연결');
    await act(async () => { findEvidenceAddBtn()!.click(); }); // 폼 펼침(토글 버튼 → 폼으로 치환)
    const refInput = container.querySelector('input[placeholder="URL 또는 참조"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(refInput, 'https://example.com/proof');
      refInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { findEvidenceAddBtn()!.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('https://example.com/proof');
    expect(container.textContent).not.toContain('증거 연결 실패');
  });

  it('POST 응답이 봉투({data,error,meta})로 이중포장되면 실패로 처리한다(과거 회귀 재현 — 반드시 통과해야 함)', async () => {
    await renderExpanded();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        // 과거 버그 재현: apiSuccess가 한 번 더 감싼 형상.
        return new Response(JSON.stringify({
          data: { id: 'ev-1', type: 'url', ref: 'https://example.com/proof' },
          error: null, meta: null,
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));

    const findEvidenceAddBtn = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '증거 연결');
    await act(async () => { findEvidenceAddBtn()!.click(); }); // 폼 펼침
    const refInput = container.querySelector('input[placeholder="URL 또는 참조"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(refInput, 'https://example.com/proof');
      refInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { findEvidenceAddBtn()!.click(); await Promise.resolve(); await Promise.resolve(); });

    // 형상 가드가 봉투({data,error,meta}에는 최상위 'type'/'ref'가 없음)를 거부해야 한다 —
    // 거부하지 못하면 items에 깨진 객체가 들어가 렌더가 이상해진다(과거 실제 회귀).
    expect(container.textContent).toContain('증거 연결 실패');
  });
});

describe('EvidenceSection — 아티팩트 버전 pin(story #2722 AC2)', () => {
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

  it('artifact_id+artifact_version_number가 있는 evidence는 링크가 아니라 버튼(그 버전 열기)으로 렌더된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/evidence?')) {
        return new Response(JSON.stringify({
          data: [{
            id: 'ev-artifact-1', org_id: 'org-1', work_item_id: 's1', work_item_type: 'story',
            type: 'report', ref: 'entity:artifact:art-1', source: null, note: '재검증 근거',
            created_by: 'member-1', created_at: '2026-08-17T00:00:00Z',
            artifact_version_id: 'ver-2', artifact_id: 'art-1', artifact_version_number: 2,
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    }));
    await act(async () => {
      root.render(wrap(
        <EvidenceSection workItemId="s1" workItemType="story" selfReported={true} humanVerified={null} humanVerifiedBy={null} humanVerifiedAt={null} />,
      ));
    });
    const toggleBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('근거 보기'));
    await act(async () => { toggleBtn!.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('재검증 근거');
    const anchors = Array.from(container.querySelectorAll('a')).filter((a) => a.textContent?.includes('재검증 근거'));
    expect(anchors).toHaveLength(0); // <a href=ref>로 렌더되면 안 됨(외부 링크 아니라 버전 pin 열기)
    const evidenceBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('재검증 근거'));
    expect(evidenceBtn).toBeTruthy();
  });

  it('클릭하면 pin된 버전(latest 아님)으로 아티팩트 상세를 조회한다', async () => {
    const versionDetailCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/evidence?')) {
        return new Response(JSON.stringify({
          data: [{
            id: 'ev-artifact-1', org_id: 'org-1', work_item_id: 's1', work_item_type: 'story',
            type: 'report', ref: 'entity:artifact:art-1', source: null, note: '재검증 근거',
            created_by: 'member-1', created_at: '2026-08-17T00:00:00Z',
            artifact_version_id: 'ver-1', artifact_id: 'art-1', artifact_version_number: 1,
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/versions/1')) {
        versionDetailCalls.push(url);
        return new Response(JSON.stringify({
          data: {
            id: 'art-1', title: '재검증 대상', story_id: 's1', epic_id: null, doc_id: null,
            source: 'created', latest_version_number: 3, anchor_version: null,
            created_by: 'member-1', created_at: '2026-08-17T00:00:00Z',
            version_number: 1, version_summary: 'v1',
            nodes: [{ id: 'n1', type: 'html_blob', props: { html: '<div>v1</div>' }, parent_id: null, sort_order: 0 }],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/versions')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));
    await act(async () => {
      root.render(wrap(
        <EvidenceSection workItemId="s1" workItemType="story" selfReported={true} humanVerified={null} humanVerifiedBy={null} humanVerifiedAt={null} />,
      ));
    });
    const toggleBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('근거 보기'));
    await act(async () => { toggleBtn!.click(); await Promise.resolve(); await Promise.resolve(); });

    const evidenceBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('재검증 근거'));
    await act(async () => { evidenceBtn!.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // artifact_version_number=1(pin된 값)로 조회했는지 — latest(3)로 조회했으면 이 스토리의
    // 존재 이유(«그 시각 고정») 자체가 깨진다.
    expect(versionDetailCalls.some((u) => u.includes('/art-1/versions/1'))).toBe(true);
  });
});
