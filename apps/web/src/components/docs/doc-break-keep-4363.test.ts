/**
 * story #4363 AC2 — 문서 게이트 · 상태 레일 · 문서 편집 화면의 한국어 문장 줄은 낱말 단위로 줄을 바꾼다(`break-keep`).
 *
 * 전수 표(PR 본문)에서 «고침»으로 판정한 자리를 한 줄씩 고정한다. 자리마다 그 요소를 가리키는 정규식이 **정확히 한 번** 맞아야 한다
 * (마크업이 바뀌어 정규식이 헛돌면 «통과»가 아니라 RED — 표가 낡았다는 뜻). 사용자가 쓴 글(반려 사유 · 결재 메모)은 끊김 없는 긴
 * 토큰(URL 등)이 넘치지 않게 `[overflow-wrap:anywhere]`도 함께 본다.
 * 못 보는 것: 표에 없는 새 문장 줄(새로 생기면 표와 이 목록에 같이 올린다) · 실제 폭에서의 모양(유나 390/360 실측이 맡음).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(WEB_SRC, rel), 'utf8');

const GATE = 'components/docs/doc-gate-section.tsx';
const RAIL = 'components/docs/doc-status-rail.tsx';
const PAGE = 'app/(authenticated)/[ws]/[proj]/docs/[slug]/page.tsx';
const BANNER = 'components/docs/doc-sync-banner.tsx';
const EDITOR = 'components/docs/doc-editor.tsx';
const URL_DIALOG = 'components/docs/doc-url-dialog.tsx';

interface Site {
  name: string;
  file: string;
  /** 첫 캡처 = 그 요소의 className */
  re: RegExp;
  /** 사용자가 쓴 글 — 긴 토큰도 넘치지 않게 */
  userText?: boolean;
}

const SITES: Site[] = [
  { name: 'gate · 검토자 고르개 오류', file: GATE, re: /className="([^"]*)">\{approverError\}/g },
  { name: 'gate · 동명 계정 경고', file: GATE, re: /className="([^"]*)">\{t\('docGateApproverPickerDuplicateWarning'\)\}/g },
  { name: 'gate · 응답 대기 문구', file: GATE, re: /<span className="([^"]*)">\s*\{t\('docGateAwaitingGeneric'\)\}/g },
  { name: 'gate · 반려 사유 본문', file: GATE, re: /className="([^"]*)">\{gate\?\.resolution_note/g, userText: true },
  { name: 'gate · 결재 이력 «누가 무엇을»', file: GATE, re: /<p className="([^"]*)">\s*\{t\(ev\.nameFallback/g },
  { name: 'gate · 결재 이력 메모', file: GATE, re: /className="([^"]*)">\{ev\.note\}/g, userText: true },
  { name: 'gate · 반려 사유 입력 안내', file: GATE, re: /className="([^"]*)">\{t\('docGateRejectReasonLabel'\)\}/g },
  { name: 'gate · 반려 사유 입력 placeholder', file: GATE, re: /placeholder=\{t\('docGateRejectReasonPlaceholder'\)\}\s*className="([^"]*)"/g },
  { name: 'rail · 전이 오류', file: RAIL, re: /className="([^"]*)">\{error\}<\/p>/g },
  { name: 'rail · 반려 사유', file: RAIL, re: /<div className="([^"]*)">\s*<span className="font-medium">\{t\('docGateDeniedReason'\)\}/g, userText: true },
  { name: 'rail · 응답 대기 문구', file: RAIL, re: /className="([^"]*)">\{t\('docGateAwaitingGeneric'\)\}/g },
  { name: 'rail · 결재 이력 메모', file: RAIL, re: /className="([^"]*)">\{ev\.note\}/g, userText: true },
  { name: '편집 화면 · 문서 없음', file: PAGE, re: /className="([^"]*)">\{t\('notFound'\)\}/g },
  { name: '편집 화면 · 복사 실패', file: PAGE, re: /className="([^"]*)">\{tc\('copyFailedSelectManually'\)\}/g },
  { name: '편집 화면 · 동기화 배너 제목', file: BANNER, re: /<AlertTitle className="([^"]*)">\{labels\.title\}/g },
  { name: '편집 화면 · 동기화 배너 경고', file: BANNER, re: /<AlertDescription className="([^"]*)">\{labels\.discardWarning\}/g },
  { name: '편집 화면 · 첨부 끌어 놓기 제목', file: EDITOR, re: /className="([^"]*)">\{tEditor\('attachDropTitle'\)\}/g },
  { name: '편집 화면 · 첨부 끌어 놓기 안내', file: EDITOR, re: /className="([^"]*)">\{tEditor\('attachDropHint'\)\}/g },
  { name: 'URL 편집 · 설명', file: URL_DIALOG, re: /<DialogDescription className="([^"]*)">\{labels\.urlDialogDesc\}/g },
  { name: 'URL 편집 · 이미 사용 중', file: URL_DIALOG, re: /<p className="([^"]*)">\s*\{labels\.slugTaken\}/g },
  { name: 'URL 편집 · 유효하지 않음', file: URL_DIALOG, re: /className="([^"]*)"[^>]*>\{labels\.slugInvalid\}/g },
  { name: 'URL 편집 · 기존 링크 안내', file: URL_DIALOG, re: /<p className="([^"]*)">\s*<Info[^>]*\/>\s*\{labels\.aliasNote\}/g },
];

describe('story #4363 — 문서 화면 문장 줄 break-keep 전수', () => {
  it.each(SITES)('$name', ({ file, re, userText }) => {
    const matches = [...read(file).matchAll(re)];
    expect(matches.length, '이 자리를 가리키는 정규식이 정확히 한 번 맞아야 한다(마크업이 바뀌면 표와 함께 갱신)').toBe(1);
    const classes = matches[0][1].split(/\s+/);
    expect(classes).toContain('break-keep');
    if (userText) expect(classes).toContain('[overflow-wrap:anywhere]');
  });

  it('편집기 빈 문서 안내(placeholder)만 낱말 단위 — 본문 줄바꿈은 그대로', () => {
    const css = read('app/globals.css');
    const rules = [...css.matchAll(/\.is-editor-empty\.is-empty::before \{([^}]*)\}/g)];
    expect(rules.length).toBe(1);
    expect(rules[0][1]).toContain('word-break: keep-all');
    expect(css).not.toMatch(/\.tiptap-content \.tiptap \{[^}]*word-break/);
  });

  it('표가 헛돌지 않는다 — 스물두 자리 · 여섯 파일', () => {
    expect(SITES.length).toBe(22);
    expect(new Set(SITES.map((s) => s.file)).size).toBe(6);
  });
});
