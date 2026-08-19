// story #2803 QA(까디르군) 2라운드 — resolveFormat이 docx/pptx를 함수 최상단에서 확장자
// 단독으로 확정하는지 table-driven으로 못박는다. 1라운드 수정(wordprocessingml/
// presentationml보다만 앞섬)은 여전히 그 위의 image/pdf/html 등 content-type 판정에
// 먼저 걸려 .pptx+content-type=application/pdf류가 깨진 pdf iframe으로 오라우팅되는
// 결함을 남겼다 — 이 테이블이 그 클래스 전체(오명명 조합)를 재발 없이 고정한다.
import { describe, it, expect } from 'vitest';
import { resolveFormat } from './file-viewer';

describe('resolveFormat — docx/pptx 확장자 우선순위(story #2803)', () => {
  const cases: Array<[label: string, contentType: string | null | undefined, expected: string]> = [
    // 정합 케이스 — 회귀 없음 확인.
    ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
    ['doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['photo.png', 'image/png', 'image'],
    ['report.pdf', 'application/pdf', 'pdf'],
    ['page.html', 'text/html', 'html'],
    ['notes.txt', 'text/plain', 'text'],
    ['legacy.ppt', 'application/vnd.ms-powerpoint', 'office'],
    ['legacy.doc', 'application/msword', 'office'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'office'],

    // 오명명(mismatch) — 확장자가 최종 진실이어야 한다. 이 조합들이 1라운드 수정 이후에도
    // 여전히 깨져 있던 실제 버그(까디르군 2차 지적) — .pptx가 앞선 pdf/image/html/text
    // content-type 판정에 먼저 걸려 broken iframe으로 렌더되던 경로.
    ['mismatched.pptx', 'application/pdf', 'pptx'],
    ['mismatched.docx', 'image/png', 'docx'],
    ['mismatched.pptx', 'text/html', 'pptx'],
    ['mismatched.docx', 'application/pdf', 'docx'],
    ['mismatched.pptx', 'video/mp4', 'pptx'],
    ['mismatched.docx', 'text/plain', 'docx'],
    ['mismatched.pptx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'pptx'],
    ['mismatched.docx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'docx'],
    // 확장자만 있고 ct가 없거나 알 수 없는 경우.
    ['no-ct.pptx', null, 'pptx'],
    ['no-ct.docx', undefined, 'docx'],
    ['no-ct.pptx', 'application/octet-stream', 'pptx'],

    // 확장자가 없거나 못 알아볼 때만 content-type 폴백 — docx/pptx 확장자 없이 그 ct만
    // 있는 경우는 여전히 ct로 판정(§7-3 실측 — 이 축은 그대로 유지).
    ['no-ext', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['no-ext', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
    ['unknown.xyz', 'application/x-unknown', 'unknown'],
  ];

  for (const [label, contentType, expected] of cases) {
    it(`${label} × ${contentType ?? '(no content-type)'} → ${expected}`, () => {
      expect(resolveFormat(contentType, label)).toBe(expected);
    });
  }
});
