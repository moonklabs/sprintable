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

// story #3560(제작 작업대 검증 시트, 유나 §17-24 확定 2026-09-06) — 접힘 요약 3갈래(실패/
// 모두통과/통과+해당없음) · 펼침 표(비고 열 조건) · 판정 낱말(fail만 destructive).
describe('EvidenceSection — 검증 시트(story #3560, payload.kind=verification_sheet)', () => {
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

  async function renderWithSheet(items: { name: string; verdict: 'pass' | 'fail' | 'n_a'; note?: string | null }[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/evidence?')) {
        return new Response(JSON.stringify({
          data: [{
            id: 'ev-sheet-1', org_id: 'org-1', work_item_id: 's1', work_item_type: 'story',
            type: 'report', ref: 'verification-sheet', source: null, note: null,
            created_by: 'member-1', created_at: '2026-09-06T00:00:00Z',
            artifact_version_id: null, artifact_id: null, artifact_version_number: null,
            payload: { kind: 'verification_sheet', items },
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
  }

  function findRowSummary() {
    return container.querySelector('[data-testid="evidence-verification-sheet-summary"]') as HTMLButtonElement;
  }

  it('실패 있음 — 「실패 N · 전체 M」 (실패가 있으면 실패 수부터)', async () => {
    await renderWithSheet([
      { name: '자막 표시', verdict: 'pass' },
      { name: '워터마크 위치', verdict: 'fail' },
      { name: '길이 15초 이내', verdict: 'pass' },
    ]);
    expect(findRowSummary().textContent).toContain('실패 1 · 전체 3');
  });

  it('실패 0·해당없음 0 — 「N항목 모두 통과」', async () => {
    await renderWithSheet([
      { name: '자막 표시', verdict: 'pass' },
      { name: '길이 15초 이내', verdict: 'pass' },
    ]);
    expect(findRowSummary().textContent).toContain('2항목 모두 통과');
  });

  it('실패 0·해당없음 있음 — 「통과 N · 해당 없음 M」(「모두 통과」 금지 — 일부는 안 쟀다)', async () => {
    await renderWithSheet([
      { name: '자막 표시', verdict: 'pass' },
      { name: '워터마크 위치', verdict: 'n_a' },
    ]);
    const text = findRowSummary().textContent ?? '';
    expect(text).toContain('통과 1');
    expect(text).toContain('해당 없음 1');
    expect(text).not.toContain('모두 통과');
  });

  // story #3581(유나 #3927 비차단 발견, 페드루 PO 確定 2026-09-06) — fail>0·na>0 동시
  // 참이면 예전엔 fail 갈래(「실패 N · 전체 M」)로 떨어져 na가 조용히 사라졌다. 새
  // 갈래(verificationSheetSummaryWithFailAndNa)로 분리됐는지만 검증한다 — 낱말은
  // 유나 §17-24 확定 대기라 지금 키 값은 빈 문자열(임의 문장 커밋 금지, 페드루 지시).
  it('실패 있음 + 해당없음 있음 — 새 갈래로 분리된다(예전 fail-only 문구로 떨어지지 않는다)', async () => {
    await renderWithSheet([
      { name: 'A', verdict: 'fail' },
      { name: 'B', verdict: 'n_a' },
      { name: 'C', verdict: 'pass' },
    ]);
    const text = findRowSummary().textContent ?? '';
    // 낱말 확定 전 placeholder(빈 문자열)라 지금은 이 값 — 유나 §17-24 도착 뒤 실 문구로 교체.
    expect(text).toBe('검증 시트');
  });

  it('펼침 표 — 비고가 하나도 없으면 비고 열 자체가 없다', async () => {
    await renderWithSheet([{ name: '자막 표시', verdict: 'pass' }, { name: '길이 15초 이내', verdict: 'fail' }]);
    await act(async () => { findRowSummary().click(); });
    const table = container.querySelector('[data-testid="evidence-verification-sheet-table"]') as HTMLTableElement;
    expect(table).not.toBeNull();
    expect(table.querySelectorAll('thead th').length).toBe(2);
    expect(table.textContent).not.toContain('비고');
  });

  it('펼침 표 — 하나라도 비고가 있으면 비고 열이 생기고, 없는 행은 빈 칸(지어내지 않는다)', async () => {
    await renderWithSheet([
      { name: '자막 표시', verdict: 'pass', note: '2회 재검' },
      { name: '길이 15초 이내', verdict: 'fail' },
    ]);
    await act(async () => { findRowSummary().click(); });
    const table = container.querySelector('[data-testid="evidence-verification-sheet-table"]') as HTMLTableElement;
    expect(table.querySelectorAll('thead th').length).toBe(3);
    expect(table.textContent).toContain('2회 재검');
  });

  it('판정 낱말 — fail만 destructive, pass/n_a는 muted가 아니라 foreground', async () => {
    await renderWithSheet([
      { name: 'A', verdict: 'pass' },
      { name: 'B', verdict: 'fail' },
      { name: 'C', verdict: 'n_a' },
    ]);
    await act(async () => { findRowSummary().click(); });
    const table = container.querySelector('[data-testid="evidence-verification-sheet-table"]') as HTMLTableElement;
    const verdictCells = Array.from(table.querySelectorAll('tbody tr')).map((tr) => tr.children[1]);
    expect(verdictCells[0]?.querySelector('span')?.className).toBe('text-foreground');
    expect(verdictCells[1]?.querySelector('span')?.className).toBe('text-destructive');
    expect(verdictCells[2]?.querySelector('span')?.className).toBe('text-foreground');
    // muted 금지(유나 §17-24 대비 규율) — 어느 판정 칸에도 muted 클래스가 없다.
    expect(table.innerHTML).not.toContain('text-muted-foreground"><span');
    expect(verdictCells[2]?.textContent).toBe('해당 없음'); // 새 낱말 0 — 재사용 확認
  });

  it('타입 배지가 일반 「리포트」가 아니라 「검증 시트」다', async () => {
    await renderWithSheet([{ name: 'A', verdict: 'pass' }]);
    expect(findRowSummary().parentElement?.textContent).toContain('검증 시트');
    expect(findRowSummary().parentElement?.textContent).not.toContain('리포트');
  });
});
