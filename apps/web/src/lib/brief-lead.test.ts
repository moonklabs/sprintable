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
