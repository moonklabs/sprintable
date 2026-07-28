/**
 * story #2292(보안·critical) — `applyEntity`가 title을 escape 안 해 형제 `applyAsset`과
 * 어긋나 있던 것(phishing 링크 렌더 결함). 두 함수가 같은 escape 규칙(`escapeMarkdownLinkText`)
 * 하나를 공유하는지, 그리고 escape가 실제로 위험 문자를 막는지를 고정한다.
 */
import { describe, expect, it } from 'vitest';
import { applyAsset, applyEntity, escapeMarkdownLinkText } from './chat-input';

describe('escapeMarkdownLinkText — AC2: 깨지는 입력 고정', () => {
  it('] ) [ ( \\ 를 백슬래시로 escape한다', () => {
    expect(escapeMarkdownLinkText('a]b)c[d(e\\f')).toBe('a\\]b\\)c\\[d\\(e\\\\f');
  });

  it('개행을 공백으로 바꾼다', () => {
    expect(escapeMarkdownLinkText('line1\nline2\r\nline3')).toBe('line1 line2 line3');
  });

  it('위험 문자가 없는 일반 제목은 그대로 둔다', () => {
    expect(escapeMarkdownLinkText('평범한 스토리 제목')).toBe('평범한 스토리 제목');
  });
});

describe('applyEntity — AC1: applyAsset과 같은 규칙을 쓴다(형제 비대칭 해소)', () => {
  it('⛔phishing 재현 입력 — 제목에 ](url)[ 을 심어도 링크 구조가 안 깨진다', () => {
    // 이 입력이 escape 없이 그대로 조립됐다면: `[x](https://phish.example)[y](entity:story:id) `
    // 처럼 렌더되어 «전혀 다른 외부 링크»가 본문에 심겼을 것이다(스토리 본문 그대로 재현).
    const malicious = 'x](https://phish.example)[y';
    const { text } = applyEntity('#', 1, malicious, 'story', '11111111-1111-1111-1111-111111111111');
    expect(text).toBe(
      '[x\\]\\(https://phish.example\\)\\[y](entity:story:11111111-1111-1111-1111-111111111111) ',
    );
    // escape된 결과에는 "](https://phish.example)[" 가 이스케이프 안 된 형태로 존재하지 않는다.
    expect(text).not.toContain('x](https://phish.example)[y');
  });

  it('applyAsset과 완전히 같은 escape 결과를 낸다(공유 규칙 — 형제 비대칭 없음)', () => {
    const dangerousName = 'a]b)c[d(e\\f\ng';
    const entityResult = applyEntity('#', 1, dangerousName, 'doc', '22222222-2222-2222-2222-222222222222');
    const assetResult = applyAsset('', 0, dangerousName, '33333333-3333-3333-3333-333333333333');
    const entityTitle = entityResult.text.match(/^\[(.*?)\]\(entity:doc:/)?.[1];
    const assetTitle = assetResult.text.match(/^\[(.*?)\]\(entity:asset:/)?.[1];
    expect(entityTitle).toBe(assetTitle);
  });

  it('일반 제목(위험 문자 없음)은 기존과 동일하게 동작한다(회귀 없음)', () => {
    const { text, caretPos } = applyEntity('#', 1, '평범한 제목', 'story', '11111111-1111-1111-1111-111111111111');
    expect(text).toBe('[평범한 제목](entity:story:11111111-1111-1111-1111-111111111111) ');
    expect(caretPos).toBe(text.length);
  });
});

// PO 지적(2026-07-28, #2577 머지 후) — 디디군이 BE `build_reference_token` 테스트를 임의
// 문자(이모지·다국어·중첩·기존 backslash)로 넓혔다. "규칙이 하나면 테스트도 하나여야" 하므로
// FE도 같은 문자 집합을 검증한다(backend/app/services/reference_registry.py 테스트의
// parametrize 목록과 그대로 맞춘 것 — PR #2576 참조).
describe('BE(#2282/#2576) 테스트와 동일 문자 집합 대조 — AC6 확장', () => {
  it.each([
    '日本語のタイトル [テスト] 中文标题 한국어 عربي',
    'C:\\Users\\test[1]', // title 자체에 이미 backslash가 있는 경우(이중 escape 견고성)
    '🔥 [TAG] "quoted" 日本語 (paren) \\ end — 모든 축 동시',
  ])('임의 특수문자 제목이 항상 안전하게 escape되고 href가 왕복 파싱된다: %s', (title) => {
    const { text } = applyEntity('#', 1, title, 'story', '11111111-1111-1111-1111-111111111111');
    // href(entity:type:id)는 title 내용과 무관하게 항상 정확히 재추출돼야 한다.
    const hrefMatch = text.match(/\(entity:(\w+):([0-9a-f-]{36})\)/i);
    expect(hrefMatch?.[1]).toBe('story');
    expect(hrefMatch?.[2]).toBe('11111111-1111-1111-1111-111111111111');
    // href 앞부분(링크 텍스트)에 이스케이프 안 된 ] ( ) 가 없어야 한다(구문 안 끊김).
    const beforeHref = text.slice(0, text.indexOf('](entity:'));
    const unescapedBracket = /(?<!\\)[\])(]/.test(beforeHref.slice(1));
    expect(unescapedBracket).toBe(false);
  });

  it('BE와 같은 "조직 명명 관례(`[TAG] 제목`)" 케이스도 안전하다(실제 데이터 관례 재현)', () => {
    const { text } = applyEntity('#', 1, '[E-CONNECT] 참조가 상태와 다음 행동을 들고 온다', 'story', '11111111-1111-1111-1111-111111111111');
    expect(text).toContain('\\[E-CONNECT\\]');
    const hrefMatch = text.match(/\(entity:(\w+):([0-9a-f-]{36})\)/i);
    expect(hrefMatch?.[1]).toBe('story');
  });
});

describe('AC5: escape 뒤에도 토큰이 다시 파싱된다(왕복 확認 — 막느라 못 쓰게 만들지 않는다)', () => {
  it('escape된 토큰에서 href(entity:type:id)를 그대로 추출할 수 있다(chat-bubble.tsx 파서와 동일 정규식)', () => {
    const malicious = 'x](evil)[y';
    const { text } = applyEntity('#', 1, malicious, 'story', '11111111-1111-1111-1111-111111111111');
    // chat-bubble.tsx의 실제 href 추출 정규식(entity:(\w+):(uuid)) 그대로 재사용해 검증.
    const hrefMatch = text.match(/\(entity:(\w+):([0-9a-f-]{36})\)/i);
    expect(hrefMatch?.[1]).toBe('story');
    expect(hrefMatch?.[2]).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('markdown 링크 문법 자체가 정확히 하나의 [text](url) 쌍으로 닫힌다(구문 안 끊김)', () => {
    const malicious = 'a](b)[c(d)e\\f';
    const { text } = applyEntity('#', 1, malicious, 'epic', '44444444-4444-4444-4444-444444444444');
    // 정확히 하나의 최상위 markdown 링크만 존재해야 한다 — remark가 이걸 여러 링크로 쪼개면
    // escape가 실패한 것이다. 링크 전체를 감싸는 대괄호/괄호 짝이 이스케이프되지 않은 채
    // 남아있지 않은지 확인(즉 unescaped ] 또는 ) 가 href 앞에 나타나지 않아야 한다).
    const beforeHref = text.slice(0, text.indexOf('](entity:'));
    // beforeHref 안의 모든 ] 와 ( 와 ) 는 반드시 백슬래시가 앞에 붙어 있어야 한다(이스케이프됨).
    const unescapedBracket = /(?<!\\)[\])]/.test(beforeHref.slice(1)); // 맨 앞 '[' 제외하고 검사
    expect(unescapedBracket).toBe(false);
  });
});
