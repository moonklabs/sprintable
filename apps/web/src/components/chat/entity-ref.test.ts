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

  // PO CHANGES 1회차(2026-09-16 11:42Z) C1 — 이미지 문법도 같은 클래스(문법 기호가
  // 평문 자리에 샘). `!`까지 같이 벗기지 않으면 "!캡처"처럼 느낌표만 잔존한다.
  it('⭐마크다운 이미지 문법(!)도 같이 벗긴다', () => {
    expect(toPlainPreview('![캡처](https://example.com/cap.png)')).toBe('캡처');
    expect(toPlainPreview('참고: ![스크린샷](https://x.png) 확인')).toBe('참고: 스크린샷 확인');
  });

  // story #4182(산티아고 prod 에스컬레이션 aca44e0d) — 외부 동기화(Linear 등)가 본문
  // 앞에 심는 비가시 HTML 주석 메타데이터 마커가 미리보기에 원문 그대로 새던 결함.
  it('⭐HTML 주석(linear-comment-id 마커, 실 증상 형태)이 제거되고 본문 텍스트는 보존된다', () => {
    const raw = '<!-- linear-comment-id: abc-123 -->\n\n댓글 본문 내용입니다';
    expect(toPlainPreview(raw)).toBe('댓글 본문 내용입니다');
  });

  it('여러 줄에 걸친 HTML 주석도 통째로 제거된다', () => {
    const raw = '<!--\n  linear-comment-id: abc-123\n  synced-at: 2026-09-23\n-->\n실제 내용';
    expect(toPlainPreview(raw)).toBe('실제 내용');
  });

  it('HTML 주석이 여러 개면 전부 제거된다', () => {
    const raw = '<!-- a --> 앞부분 <!-- b --> 뒷부분';
    expect(toPlainPreview(raw)).toBe('앞부분  뒷부분');
  });

  it('HTML 주석과 마크다운 링크가 섞여도 둘 다 처리된다', () => {
    const raw = '<!-- linear-comment-id: xyz -->[공지](https://example.com/notice) 확인';
    expect(toPlainPreview(raw)).toBe('공지 확인');
  });

  it('HTML 주석이 없는 일반 본문은 무변(회귀 0)', () => {
    expect(toPlainPreview('그냥 평범한 메시지입니다')).toBe('그냥 평범한 메시지입니다');
  });

  // PO CHANGES(페드루, 2026-09-23) — content_snippet은 서버가 160자로 절삭해 주므로
  // 긴 주석이 그 지점에서 잘려 `-->`가 아예 없이 끝날 수 있다(닫히지 않은 주석).
  it('⭐서버 절삭으로 닫히지 않은 HTML 주석(«-->» 없음)도 문자열 끝까지 제거된다', () => {
    const raw = '본문 앞부분 <!-- linear-comment-id: f4';
    expect(toPlainPreview(raw)).toBe('본문 앞부분');
  });
});

// PR #4541 까디르 QA ② — 코드 안의 리터럴 `<!--`는 주석이 아니다(서버와 같은 규칙).
describe('toPlainPreview — 코드 속 리터럴 주석 여는 기호(story #4182)', () => {
  it('인라인 코드 안의 `<!--`는 뒷본문을 삼키지 않는다', () => {
    expect(toPlainPreview('Use `<!--` literally. After it comes the decision')).toBe('Use `<!--` literally. After it comes the decision');
  });

  it('펜스 코드 안의 `<!--`는 뒷본문을 삼키지 않는다', () => {
    expect(toPlainPreview('Before\n```html\n<!--\n```\nAfter')).toBe('Before\n```html\n<!--\n```\nAfter');
  });

  it('코드 밖 주석은 여전히 지워진다', () => {
    expect(toPlainPreview('<!-- meta -->코드 `<!--` 는 남는다 <!-- tail')).toBe('코드 `<!--` 는 남는다');
  });
});
