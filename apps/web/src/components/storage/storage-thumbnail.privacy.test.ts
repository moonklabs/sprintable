import { describe, it, expect } from 'vitest';
import { selectSignPlan } from './storage-thumbnail';
import type { Asset, AssetSourceLink } from '@/lib/storage/types';

// #1769 codex 프라이버시 crux: selectSignPlan 우선순위 모순(story→doc→conv) → doc+conv mixed 자산이
// doc step 에서 project-scoped asset_id 로 즉시 매칭 → conv 우회. fix=conv 최우선 재정렬.
// 이 테스트가 INVARIANT("conv-sourced 자산은 절대 asset_id 로 서명 안 됨")를 잠근다.

function asset(links: AssetSourceLink[], objectPath = 'org/o/project/p/x/u-f.png'): Asset {
  return {
    id: 'ASSET-1',
    org_id: 'o',
    project_id: 'p',
    folder_id: null,
    container: 'c',
    object_path: objectPath,
    name: 'f.png',
    content_type: 'image/png',
    size_bytes: 10,
    created_at: '',
    updated_at: '',
    created_by: null,
    source_links: links,
  };
}
const conv = (id = 'CONV-1'): AssetSourceLink => ({ type: 'conversation_message', id, deeplink: { conversation_id: id } } as AssetSourceLink);
const story = (id = 'STORY-1'): AssetSourceLink => ({ type: 'story', id, deeplink: { story_id: id } } as AssetSourceLink);
const doc = (): AssetSourceLink => ({ type: 'doc', id: 'DOC-1', deeplink: { doc_slug: 'd' } } as AssetSourceLink);
const manual = (): AssetSourceLink => ({ type: 'manual', id: 'M-1', deeplink: null } as AssetSourceLink);

describe('selectSignPlan · 프라이버시 우선순위 (S4 #1769)', () => {
  it('conv only → conv sign (path + conversation_id)', () => {
    expect(selectSignPlan(asset([conv()]))).toEqual({ kind: 'path', param: 'conversation_id', id: 'CONV-1' });
  });

  it('🔒 doc+conv → conv sign (절대 asset_id 아님) — codex crux', () => {
    expect(selectSignPlan(asset([doc(), conv()]))).toEqual({ kind: 'path', param: 'conversation_id', id: 'CONV-1' });
    // 순서 무관하게 conv 최우선
    expect(selectSignPlan(asset([conv(), doc()]))).toEqual({ kind: 'path', param: 'conversation_id', id: 'CONV-1' });
  });

  it('🔒 story+conv → conv sign (story path 가능해도 conv 우선)', () => {
    expect(selectSignPlan(asset([story(), conv()]))).toEqual({ kind: 'path', param: 'conversation_id', id: 'CONV-1' });
  });

  it('🔒 conv 인데 conversation_id 없음 → phantom(null), 절대 asset_id 폴백 안 함', () => {
    const noConvId = { type: 'conversation_message', id: 'c', deeplink: {} } as AssetSourceLink;
    expect(selectSignPlan(asset([noConvId, manual()]))).toBeNull();
    // object_path 없는 conv 도 phantom(asset_id 폴백 금지)
    expect(selectSignPlan(asset([conv()], ''))).toBeNull();
  });

  it('story only → story sign (path + story_id)', () => {
    expect(selectSignPlan(asset([story()]))).toEqual({ kind: 'path', param: 'story_id', id: 'STORY-1' });
  });

  it('doc only → asset_id', () => {
    expect(selectSignPlan(asset([doc()]))).toEqual({ kind: 'asset' });
  });

  it('manual only → asset_id', () => {
    expect(selectSignPlan(asset([manual()]))).toEqual({ kind: 'asset' });
  });

  it('source 없음 → phantom(null)', () => {
    expect(selectSignPlan(asset([]))).toBeNull();
  });
});
