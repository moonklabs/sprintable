import { describe, it, expect } from 'vitest';
import { pickRegisteredAssetId } from './image-upload';

// S4 핫픽스(#1768) 계약 잠금: doc-attach register(`POST /api/docs/{id}/assets`) 응답에서
// asset id 추출. dev 끝단서 적출 — BE 실응답은 snake `data.asset_id`인데 FE가 camel `data.assetId`만
// 봐서 HTTP 200인데도 assetId=null → sign 미호출 → 이미지/파일 error state로 조용히 degrade했었다.
describe('pickRegisteredAssetId · register 응답 계약 (S4 #1768)', () => {
  it('BE 실응답 snake `{data:{asset_id}}` 를 추출한다 (계약의 1순위·회귀 잠금)', () => {
    // dev 라이브서 실측한 정확한 형상.
    const real = { data: { asset_id: '63b752eb-700c-4aa4-b437-ca8e6ae4d7e0', filename: 's4.png', size: 92, mime: 'image/png' }, error: null, meta: null };
    expect(pickRegisteredAssetId(real)).toBe('63b752eb-700c-4aa4-b437-ca8e6ae4d7e0');
  });

  it('camelCase `{data:{assetId}}` 폴백', () => {
    expect(pickRegisteredAssetId({ data: { assetId: 'a-1' } })).toBe('a-1');
  });

  it('`{data:{id}}` 폴백', () => {
    expect(pickRegisteredAssetId({ data: { id: 'a-2' } })).toBe('a-2');
  });

  it('평면 `{asset_id}` / `{assetId}` / `{id}` 폴백', () => {
    expect(pickRegisteredAssetId({ asset_id: 'a-3' })).toBe('a-3');
    expect(pickRegisteredAssetId({ assetId: 'a-4' })).toBe('a-4');
    expect(pickRegisteredAssetId({ id: 'a-5' })).toBe('a-5');
  });

  it('snake 가 camel/평면보다 우선 (실 BE 계약)', () => {
    expect(pickRegisteredAssetId({ data: { asset_id: 'snake', assetId: 'camel', id: 'plain' } })).toBe('snake');
  });

  it('없거나 비정상 응답은 null (→ 호출부가 error state graceful 처리)', () => {
    expect(pickRegisteredAssetId(null)).toBeNull();
    expect(pickRegisteredAssetId(undefined)).toBeNull();
    expect(pickRegisteredAssetId({})).toBeNull();
    expect(pickRegisteredAssetId({ data: null })).toBeNull();
    expect(pickRegisteredAssetId({ data: { filename: 'x.png' } })).toBeNull();
  });
});
