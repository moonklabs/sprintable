// story #2888(S2a) — parseEntityRef SSOT. 3중 복제(chat-bubble ×2·embed-card·
// doc-content-renderer)가 이 함수 하나로 수렴했다는 회귀가드.
import { describe, expect, it } from 'vitest';
import { parseEntityRef } from './entity-ref';

const UUID = '12345678-90ab-cdef-1234-567890abcdef';

describe('parseEntityRef (story #2888)', () => {
  it('entity:타입:UUID 형태를 파싱한다', () => {
    expect(parseEntityRef(`entity:story:${UUID}`)).toEqual({ entityType: 'story', entityId: UUID });
  });

  it('대문자 UUID도 매칭한다(대소문자 무관)', () => {
    expect(parseEntityRef(`entity:doc:${UUID.toUpperCase()}`)).toEqual({ entityType: 'doc', entityId: UUID.toUpperCase() });
  });

  it('asset 타입도 동일하게 파싱한다(asset 배제는 호출부 몫)', () => {
    expect(parseEntityRef(`entity:asset:${UUID}`)).toEqual({ entityType: 'asset', entityId: UUID });
  });

  it('비-UUID id는 매칭 실패(null)한다', () => {
    expect(parseEntityRef('entity:story:dead')).toBeNull();
    expect(parseEntityRef('entity:story:----')).toBeNull();
  });

  it('entity: 스킴이 아니면 null', () => {
    expect(parseEntityRef(`mention:story:${UUID}`)).toBeNull();
    expect(parseEntityRef('https://example.com')).toBeNull();
  });

  it('href가 undefined/null이면 null', () => {
    expect(parseEntityRef(undefined)).toBeNull();
    expect(parseEntityRef(null)).toBeNull();
  });
});
