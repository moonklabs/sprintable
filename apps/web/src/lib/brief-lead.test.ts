import { describe, expect, it } from 'vitest';
import { extractBriefLead } from './brief-lead';

describe('extractBriefLead (story #178c7c6d, 3015 시안 ② 표현층)', () => {
  it('첫 ## 헤딩 앞 프로즈만 리드로 추출하고, 이후 섹션은 버린다', () => {
    const raw = 'doc `workcell-bento-form-material-spec-2984`가 구현 SSOT.\n\n## 범위\n- 대상: `apps/web/src/components/kanban/story-detail-panel.tsx`\n## 처방\n뭔가';
    expect(extractBriefLead(raw)).toBe('doc workcell-bento-form-material-spec-2984가 구현 SSOT.');
  });

  it('백틱 코드 기호를 제거하고 내용만 남긴다', () => {
    expect(extractBriefLead('`workcell.tsx` 파일을 고친다')).toBe('workcell.tsx 파일을 고친다');
  });

  it('리스트 대시/별표 마커를 줄 앞에서 제거한다(내용은 유지)', () => {
    const raw = '- 첫 항목\n- 둘째 항목\n* 셋째 항목';
    expect(extractBriefLead(raw)).toBe('첫 항목\n둘째 항목\n셋째 항목');
  });

  it('순서 리스트 마커(1. 2. …)를 줄 앞에서 제거한다', () => {
    expect(extractBriefLead('1. 하나\n2. 둘')).toBe('하나\n둘');
  });

  it('[링크](url) 문법을 링크 텍스트만 남기고 스트립한다', () => {
    expect(extractBriefLead('[문서](https://example.com)를 참고')).toBe('문서를 참고');
  });

  it('헤딩이 없으면 전문을 리드로 취급(스트립만 적용)', () => {
    expect(extractBriefLead('그냥 평문 목표 텍스트')).toBe('그냥 평문 목표 텍스트');
  });

  it('전체가 헤딩으로 시작해 리드가 비면, 그 헤딩 텍스트 자체를 폴백으로 쓴다(빈 Brief 방지·지어내지 않음)', () => {
    expect(extractBriefLead('## 제목만 있음\n본문 내용')).toBe('제목만 있음');
  });

  it('verbatim — 리라이트·요약 없이 원문 문구를 정확히 보존한다(스트립 결과 외 변형 0)', () => {
    const raw = '실패한 결제를 재시도로 복구하는 로직 구현 — AC 4개 충족까지';
    expect(extractBriefLead(raw)).toBe(raw);
  });

  it('빈 문자열/공백만 있는 입력은 빈 리드를 반환한다(지어낸 대체 텍스트 없음)', () => {
    expect(extractBriefLead('')).toBe('');
    expect(extractBriefLead('   \n  ')).toBe('');
  });

  it('앞뒤 공백을 트림한다', () => {
    expect(extractBriefLead('  앞뒤 공백 텍스트  \n\n')).toBe('앞뒤 공백 텍스트');
  });
});

// 카디르 QA(#3445 head 6c88b2ef3) HIGH 적출 — 굵게(**)·기울임(_/*)·인용(>)·이미지(![alt](url))가
// 안 걷혀 "마크다운 노출 0" 주장과 실측 불일치. 카디르가 직접 실측한 repro 그대로 회귀가드화.
describe('extractBriefLead — 카디르 QA(#3445) HIGH: 굵게·기울임·인용·이미지 스트립', () => {
  it('카디르 실측 repro 그대로 — 인용·굵게·기울임·이미지가 전부 스트립된다', () => {
    // 원 repro: extractBriefLead('> **bold** and _italic_ ![alt](img.png)') → '> **bold** and _italic_ !alt'(버그)
    expect(extractBriefLead('> **bold** and _italic_ ![alt](img.png)')).toBe('bold and italic alt');
  });

  it('굵게(**text**)를 스트립한다', () => {
    expect(extractBriefLead('**중요** 표시')).toBe('중요 표시');
  });

  it('기울임(*text*)을 스트립한다(리스트 별표 마커와 구분 — 마커는 뒤에 공백, 강조는 공백 없음)', () => {
    expect(extractBriefLead('*강조* 표시')).toBe('강조 표시');
  });

  it('기울임(_text_)을 스트립하되, snake_case 식별자는 훼손하지 않는다(단어 경계 가드)', () => {
    expect(extractBriefLead('_강조_ 표시')).toBe('강조 표시');
    expect(extractBriefLead('workcell_bento_form 식별자')).toBe('workcell_bento_form 식별자');
  });

  it('인용 마커(>)를 줄 앞에서 제거한다', () => {
    expect(extractBriefLead('> 인용된 문장')).toBe('인용된 문장');
  });

  it('이미지 ![alt](url)를 alt 텍스트만 남기고 스트립한다("!" 잔존 없음)', () => {
    expect(extractBriefLead('![스크린샷](img.png) 참고')).toBe('스크린샷 참고');
  });

  it('+ 리스트 마커·1) 형 순서 리스트 마커도 제거한다', () => {
    expect(extractBriefLead('+ 플러스 항목')).toBe('플러스 항목');
    expect(extractBriefLead('1) 괄호형 항목')).toBe('괄호형 항목');
  });

  it('task-list 체크박스(- [ ]/- [x])를 마커째 제거한다', () => {
    expect(extractBriefLead('- [ ] 할 일\n- [x] 완료한 일')).toBe('할 일\n완료한 일');
  });
});

// 카디르 QA(#3445) MEDIUM 적출 — 빈 헤딩 폴백이 "빈 Brief 방지" 취지와 어긋남.
describe('extractBriefLead — 카디르 QA(#3445) MEDIUM: 빈 헤딩 폴백', () => {
  it('빈 헤딩(## 뒤 공백만) 다음에 실제 본문이 있으면, 그 본문을 리드로 쓴다(빈 값 반환 금지)', () => {
    // 원 repro: extractBriefLead('##   \nbody after') → ''(버그 — 본문이 있는데 빈 값)
    expect(extractBriefLead('##   \nbody after')).toBe('body after');
  });

  it('빈 헤딩만 있고 뒤에 아무 내용도 없으면 정직하게 빈 문자열(## 마커 잔존 없음)', () => {
    // 원 repro: extractBriefLead('## ') → '##'(버그 — 마커 잔존)
    expect(extractBriefLead('## ')).toBe('');
  });

  it('연속된 빈 헤딩 여러 개를 전부 건너뛰고 그 다음 실제 내용을 찾는다', () => {
    expect(extractBriefLead('##  \n###   \n실제 내용')).toBe('실제 내용');
  });
});
