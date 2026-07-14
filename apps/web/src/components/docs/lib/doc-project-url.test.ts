// prod P0(2026-07-14) — 실측 근본 회귀가드. `docs-client-layout.tsx`의 createDoc과
// `[slug]/page.tsx`의 fetchDoc이 각각 이 두 헬퍼로 URL을 만든다 — 둘 다 `?p=`를 명시하는지가
// 정확히 이번 버그의 crux(생략하면 useProjectSsot의 fallback 체인이 다시 태워져 다른 project로
// 재질의될 수 있음, dev 크로스-org 전환으로 라이브 재현 완료).
import { describe, expect, it } from 'vitest';
import { newDocUrl, docsListUrl } from './doc-project-url';

describe('newDocUrl — 신규 문서 생성 직후 이동 URL', () => {
  it('includes ?p= with the exact project the doc was created under (레이스 근본 봉쇄)', () => {
    expect(newDocUrl('untitled-123', 'proj-a')).toBe('/docs/untitled-123?new=1&p=proj-a');
  });

  it('never omits p= even for a project id that looks like a query-string edge case', () => {
    const url = newDocUrl('untitled-999', 'proj-b');
    const params = new URL(url, 'http://x').searchParams;
    expect(params.get('p')).toBe('proj-b');
    expect(params.get('new')).toBe('1');
  });
});

describe('docsListUrl — not-found 회복 리다이렉트 URL', () => {
  it('points back to the docs list scoped to the current (correct) project', () => {
    expect(docsListUrl('proj-c')).toBe('/docs?p=proj-c');
  });
});
