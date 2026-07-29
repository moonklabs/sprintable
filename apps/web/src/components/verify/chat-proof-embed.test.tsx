// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatProofEmbed } from './chat-proof-embed';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const BASE_MESSAGES = [
  { id: 'm1', senderName: '오르테가', content: '이 방향으로 가시는' },
  { id: 'm2', senderName: '미르코', content: '확認했는' },
];

describe('ChatProofEmbed — story #2265(C-7) PR1a 4상태', () => {
  it('정상 상태 — 인용 메시지가 그대로 렌더되고 변경 신호가 없다', () => {
    const html = renderToStaticMarkup(wrap(
      <ChatProofEmbed
        sourceLabel="채팅 · 7/26 · 오르테가군 외 2명"
        conversationHref="/chats/conv-1?messageId=m1"
        messages={BASE_MESSAGES}
        quotedAt="7/26"
        status="normal"
      />,
    ));
    expect(html).toContain('이 방향으로 가시는');
    expect(html).toContain('확認했는');
    expect(html).toContain('대화에서 열기');
    expect(html).not.toContain('삭제됨');
    expect(html).not.toContain('수정되었습니다');
  });

  it('수정됨 — 박힌 시점 내용은 그대로 유지되고 «원본이 수정되었습니다»가 얹힌다(자동 교체 아님)', () => {
    const html = renderToStaticMarkup(wrap(
      <ChatProofEmbed
        sourceLabel="채팅 · 7/26 · 오르테가군 외 2명"
        conversationHref="/chats/conv-1?messageId=m1"
        messages={BASE_MESSAGES}
        quotedAt="7/26"
        status="edited"
        editedAt="7/28"
      />,
    ));
    // 박힌 시점 내용이 살아있다 — 조용한 교체가 아니라 "얹기"임을 확認.
    expect(html).toContain('이 방향으로 가시는');
    expect(html).toContain('원본이 수정되었습니다');
    expect(html).toContain('7/28');
    expect(html).toContain('지금 원본 보기');
  });

  it('삭제됨 — 내용은 접히고(안 보이고) «삭제됨» 표지 + 인용 시점이 선다', () => {
    const html = renderToStaticMarkup(wrap(
      <ChatProofEmbed
        sourceLabel="채팅 · 7/26 · 오르테가군 외 2명"
        conversationHref="/chats/conv-1?messageId=m1"
        messages={BASE_MESSAGES}
        quotedAt="7/26"
        status="deleted"
      />,
    ));
    expect(html).not.toContain('이 방향으로 가시는');
    expect(html).toContain('삭제됨');
    expect(html).toContain('원본이 삭제되었습니다');
    expect(html).toContain('인용 시점');
  });

  it('권한없음 — 내용·출처줄 전부 안 보이고 «볼 수 없습니다 · 권한»만 선다(삭제됨과 다른 문구)', () => {
    const html = renderToStaticMarkup(wrap(
      <ChatProofEmbed
        sourceLabel="채팅 · 7/26 · 오르테가군 외 2명"
        conversationHref={null}
        messages={BASE_MESSAGES}
        quotedAt="7/26"
        status="no_access"
      />,
    ));
    expect(html).not.toContain('이 방향으로 가시는');
    expect(html).not.toContain('채팅 · 7/26');
    expect(html).not.toContain('삭제됨');
    expect(html).toContain('볼 수 없습니다');
    expect(html).toContain('권한');
  });

  it('잘림 표시 — 앞/뒤 생략 줄 수가 실제로 렌더된다', () => {
    const html = renderToStaticMarkup(wrap(
      <ChatProofEmbed
        sourceLabel="채팅 · 7/26 · 오르테가군 외 2명"
        conversationHref="/chats/conv-1?messageId=m1"
        messages={BASE_MESSAGES}
        quotedAt="7/26"
        status="normal"
        truncatedBefore={12}
        truncatedAfter={3}
      />,
    ));
    expect(html).toContain('앞 12줄 생략');
    expect(html).toContain('뒤 3줄 생략');
  });

  it('conversationHref가 null이면(권한 없음 아닌 다른 사유) «대화에서 열기» 링크를 안 그린다', () => {
    const html = renderToStaticMarkup(wrap(
      <ChatProofEmbed
        sourceLabel="채팅 · 7/26 · 오르테가군 외 2명"
        conversationHref={null}
        messages={BASE_MESSAGES}
        quotedAt="7/26"
        status="normal"
      />,
    ));
    expect(html).not.toContain('대화에서 열기');
  });

  it('사용자 노출 문구에 구조 이름(참조·임베드)이 안 섞인다 — PO 규율(2026-07-29)', () => {
    const html = renderToStaticMarkup(wrap(
      <ChatProofEmbed
        sourceLabel="채팅 · 7/26 · 오르테가군 외 2명"
        conversationHref="/chats/conv-1?messageId=m1"
        messages={BASE_MESSAGES}
        quotedAt="7/26"
        status="edited"
        editedAt="7/28"
      />,
    ));
    for (const forbidden of ['참조', '임베드', 'reference', 'embed']) {
      expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
