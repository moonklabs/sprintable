// story #2888(S2a) — parseEntityRef SSOT. 3중 복제(chat-bubble ×2·embed-card·
// doc-content-renderer)가 이 함수 하나로 수렴했다는 회귀가드.
import { describe, expect, it } from 'vitest';
import { parseEntityRef, toPlainPreview } from './entity-ref';

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

// story #3949(E-UX-OVERHAUL·customer-zero·§①) — 미리보기/요약 전용 평문화 헬퍼.
// 실 레코드 fixture = PO 라이브 실측 메시지(b676dc29·대화 6a584f3e) 원문 형태 재현.
describe('toPlainPreview (story #3949)', () => {
  it('⭐실 레코드 fixture(b676dc29 원문 형태) — entity 참조 토큰이 라벨만 남는다', () => {
    const raw = '[PO 픽스처 2·삭제예정] 같은 org 산출물 참조 [\\[PO 픽스처 산출물…\\]]'
      + '(entity:artifact:c92d9614-1111-2222-3333-444455556666)';
    const result = toPlainPreview(raw);
    expect(result).toBe('[PO 픽스처 2·삭제예정] 같은 org 산출물 참조 [PO 픽스처 산출물…]');
    expect(result).not.toContain('entity:');
    expect(result).not.toContain('](');
  });

  it('일반 마크다운 링크(entity: 스킴 아님)도 라벨만 남는다', () => {
    expect(toPlainPreview('참고: [공지](https://example.com/notice)')).toBe('참고: 공지');
  });

  it('마크다운 문법이 없으면 무변(trim만)', () => {
    expect(toPlainPreview('그냥 평범한 메시지입니다')).toBe('그냥 평범한 메시지입니다');
    expect(toPlainPreview('  앞뒤 공백  ')).toBe('앞뒤 공백');
  });

  it('토큰이 여러 개면 전부 라벨만 남는다', () => {
    const raw = '[문서A](entity:doc:aaaaaaaa-0000-0000-0000-000000000000)와 '
      + '[문서B](entity:doc:bbbbbbbb-0000-0000-0000-000000000000) 둘 다 참고';
    expect(toPlainPreview(raw)).toBe('문서A와 문서B 둘 다 참고');
  });

  it('빈 문자열은 빈 문자열', () => {
    expect(toPlainPreview('')).toBe('');
  });
});
