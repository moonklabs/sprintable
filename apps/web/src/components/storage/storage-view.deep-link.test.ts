/**
 * story #2302 AC1 — `/storage?asset=` 딥링크가 지금까지 사문(死文)이었다(searchParams를 읽는
 * 코드 자체가 없었다). "첫 페이지에 있을 때만 되는 링크"는 반쪽 fix(PO 판정 — epic 404와 같은
 * 부류: 갈 수 있다고 말하고 배신하는 것이 제일 나쁘다)라, 페이지에 없으면 무조건 포기하지 않고
 * 단건조회 폴백으로 넘긴다는 판정 로직만 순수 함수로 검증한다.
 */
import { describe, expect, it } from 'vitest';
import { resolveAssetDeepLinkAction } from './storage-view';

const BASE = { projectId: 'p1', selectedAssetId: null as string | null, items: [] as { id: string }[], loading: false };

describe('resolveAssetDeepLinkAction', () => {
  it('asset 파라미터가 없으면 아무것도 안 한다', () => {
    expect(resolveAssetDeepLinkAction({ ...BASE, assetId: null })).toEqual({ type: 'none' });
  });

  it('이미 그 asset이 선택돼 있으면 재실행하지 않는다(무한루프 방지)', () => {
    expect(resolveAssetDeepLinkAction({ ...BASE, assetId: 'a1', selectedAssetId: 'a1' })).toEqual({ type: 'none' });
  });

  it('현재 로드된 페이지(items)에 있으면 그대로 선택한다 — fetch 불필요', () => {
    expect(resolveAssetDeepLinkAction({ ...BASE, assetId: 'a1', items: [{ id: 'a1' }, { id: 'a2' }] }))
      .toEqual({ type: 'select-from-page', assetId: 'a1' });
  });

  it('⛔현재 페이지에 없어도 «아직 로딩 중»이면 포기하지 않고 기다린다(첫 페이지 결과부터 본다)', () => {
    expect(resolveAssetDeepLinkAction({ ...BASE, assetId: 'a1', items: [], loading: true }))
      .toEqual({ type: 'wait' });
  });

  it('⭐로딩이 끝났는데도 현재 페이지에 없으면 단건조회 폴백으로 넘긴다(반쪽 링크 금지의 핵심)', () => {
    expect(resolveAssetDeepLinkAction({ ...BASE, assetId: 'a1', items: [{ id: 'a2' }], loading: false }))
      .toEqual({ type: 'fetch-fallback', assetId: 'a1' });
  });

  it('projectId가 없으면(아직 컨텍스트 미해소) 아무것도 안 한다', () => {
    expect(resolveAssetDeepLinkAction({ ...BASE, assetId: 'a1', projectId: '' })).toEqual({ type: 'none' });
  });
});
