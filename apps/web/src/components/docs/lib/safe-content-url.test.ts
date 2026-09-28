// @vitest-environment jsdom
// story #4324 — URL 거름 도우미 표 테스트. 까디르 QA 우회 값(PR 4684 댓글 5840417523) 26개를 **원문 그대로** 고정하고, 그 댓글이 «고친 뒤
// 넣을 것»으로 적은 MIME 안 탭/개행 둘, 허용 목록 전환(PO 22:14Z) 쪽 대조를 더한다.
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_DATA_MIME_ALLOWLIST, safeAttachmentDataUrl, safeHttpUrl } from './safe-content-url';

/** 까디르 `dec(s)` — 렌더러가 읽는 길 그대로(속성으로 쓴 값을 DOM이 풀어 getAttribute로 읽음). */
function dec(s: string): string {
  const d = document.createElement('div');
  d.innerHTML = `<span data-x="${s}"></span>`;
  return d.firstElementChild!.getAttribute('data-x')!;
}

describe('까디르 QA 표 — safeHttpUrl이 null(13)', () => {
  const cases: [string, string][] = [
    ['대소문자', 'JaVaScRiPt:alert(1)'],
    ['앞 공백 · 탭 · 개행', ' \t\njavascript:alert(1)'],
    ['스킴 안 탭', 'java\tscript:alert(1)'],
    ['스킴 안 개행', 'java\nscript:alert(1)'],
    ['앞 제어 문자', '\u0001javascript:alert(1)'],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['data:text/html', 'data:text/html,<script>alert(1)</script>'],
    ['blob', 'blob:https://x/1'],
    ['스킴 없는 //', '//evil.example/x'],
    ['상대', '/relative'],
    ['엔티티 &#x6A;', dec('&#x6A;avascript:alert(1)')],
    ['엔티티 &colon;', dec('javascript&colon;alert(1)')],
    ['엔티티 &#106;&#97;', dec('&#106;&#97;vascript:alert(1)')],
  ];
  it.each(cases)('%s', (_label, value) => {
    expect(safeHttpUrl(value)).toBeNull();
  });
});

describe('까디르 QA 표 — safeAttachmentDataUrl이 null(11) + MIME 안 탭/개행(2)', () => {
  const cases: [string, string][] = [
    ['javascript', 'javascript:alert(1)'],
    ['data:text/html', 'data:text/html,<script>alert(1)</script>'],
    ['DATA: 대문자 · base64', 'DATA:TEXT/HTML;base64,PHNjcmlwdD4='],
    ['MIME 앞 공백', 'data: text/html,<b>'],
    ['svg', 'data:image/svg+xml,<svg onload=alert(1)>'],
    ['svg base64', 'data:image/svg+xml;base64,PHN2Zz4='],
    ['xhtml', 'data:application/xhtml+xml,<x/>'],
    ['text/xml', 'data:text/xml,<x/>'],
    ['엔티티 &#x64;', dec('&#x64;ata:text/html,<script>1</script>')],
    ['앞 제어 문자', '\u0001data:text/html,<script>1</script>'],
    ['MIME 뒤 탭', 'data:text/html\t,<script>1</script>'],
    // 까디르 댓글이 «고친 뒤 넣을 것»으로 적은 둘 — 예전 거부 목록은 통과시켰다(뮤테이션 대조).
    ['MIME 안 탭', 'data:text/\thtml,<script>1</script>'],
    ['MIME 안 개행', 'data:image/sv\ng+xml,<svg onload=alert(1)>'],
  ];
  it.each(cases)('%s', (_label, value) => {
    expect(safeAttachmentDataUrl(value)).toBeNull();
  });
});

describe('까디르 QA 표 — 통과(2) · 음성 대조', () => {
  it('https 링크는 그대로', () => {
    expect(safeHttpUrl('https://youtu.be/abc')).toBe('https://youtu.be/abc');
  });
  it('pdf 첨부는 통과', () => {
    expect(safeAttachmentDataUrl('data:application/pdf;base64,JVBERi0=')).not.toBeNull();
  });
});

describe('허용 목록(PO 22:14Z) — 목록 밖은 거절 · 검사한 값 = 돌려주는 값', () => {
  it.each([
    ['파라미터가 붙은 html', 'data:text/html;charset=utf-8,<script>1</script>'],
    ['퍼센트 인코딩 슬래시', 'data:text%2Fhtml,<script>1</script>'],
    ['javascript MIME', 'data:text/javascript,alert(1)'],
    ['빈 MIME', 'data:;base64,AA'],
    ['쉼표 없음', 'data:application/pdf;base64'],
    ['목록 밖 흔한 종류(json)', 'data:application/json,{}'],
  ])('%s → null', (_label, value) => {
    expect(safeAttachmentDataUrl(value)).toBeNull();
  });

  it('허용 목록의 모든 종류는 통과 · 대소문자 무관', () => {
    for (const mime of ATTACHMENT_DATA_MIME_ALLOWLIST) {
      expect(safeAttachmentDataUrl(`data:${mime};base64,AA`), mime).toBe(`data:${mime};base64,AA`);
      expect(safeAttachmentDataUrl(`DATA:${mime.toUpperCase()};base64,AA`), mime).not.toBeNull();
    }
  });

  it('svg · html · xml 계열은 허용 목록에 없다', () => {
    for (const mime of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml']) {
      expect(ATTACHMENT_DATA_MIME_ALLOWLIST.has(mime), mime).toBe(false);
    }
  });

  it('탭 · 개행 · 제어 문자를 지운 값을 돌려준다(검사한 문자열 = href)', () => {
    expect(safeAttachmentDataUrl(' data:application/pdf;base64,JV\tBE\nRi0=\u0000')).toBe('data:application/pdf;base64,JVBERi0=');
    expect(safeHttpUrl(' https://ex\tample.com/\na ')).toBe('https://example.com/a');
  });
});
