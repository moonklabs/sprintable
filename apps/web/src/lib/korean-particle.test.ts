import { describe, expect, it } from 'vitest';
import { pickEulReulJosa, pickEunNeunJosa, pickEuroJosa, pickIGaJosa } from './korean-particle';

// story #3698(IA·후속) — 커맨드 팔레트 "{label}(으)로 이동" 동적 조립에서 실측으로 잡힌
// 회귀(알림→"로" 오생성)의 근본 수정. 받침 유무의 기계적 규칙 — 유나 § 대상 아님(어휘
// 선택이 아니라 맞춤법).
describe('pickEuroJosa — 받침 유무에 따른 으로/로 (KS X 1001 종성 표준)', () => {
  it('받침 있음(ㄹ 제외) → 으로', () => {
    expect(pickEuroJosa('알림')).toBe('으로'); // 림=ㅁ받침
    expect(pickEuroJosa('스탠드업')).toBe('으로'); // 업=ㅂ받침
    expect(pickEuroJosa('구성원')).toBe('으로'); // 원=ㄴ받침
    expect(pickEuroJosa('콘텐츠 규칙')).toBe('으로'); // 칙=ㄱ받침
  });

  it('받침 없음 → 로', () => {
    expect(pickEuroJosa('보드')).toBe('로'); // 드=받침없음
    expect(pickEuroJosa('문서')).toBe('로'); // 서=받침없음
    expect(pickEuroJosa('목표')).toBe('로'); // 표=받침없음
    expect(pickEuroJosa('회고')).toBe('로'); // 고=받침없음
    expect(pickEuroJosa('블로그 포스트')).toBe('로'); // 트=받침없음
  });

  it('ㄹ받침은 예외로 로(다른 받침과 다르게)', () => {
    expect(pickEuroJosa('실험실')).toBe('로'); // 실=ㄹ받침
    expect(pickEuroJosa('메일')).toBe('로'); // 일=ㄹ받침
  });

  it('완성형 한글이 없으면(영문 등) 받침 없는 것과 동일하게 로로 안전 폴백', () => {
    expect(pickEuroJosa('Project')).toBe('로');
    expect(pickEuroJosa('')).toBe('로');
  });
});

// story #3824(UX-v3·FE 1, 2026-09-13) — more/page.tsx의 moreTabHint 조사 하드코딩
// (「채팅」 받침 전제로 "은" 고정)이 nav.chats="대화"(받침 없음)로 바뀌며 "대화은"
// 비문을 냈다(실측 발견) — pickEuroJosa와 동형 원리(예외 없는 종성 규칙)로 처방.
describe('pickEunNeunJosa — 받침 유무에 따른 은/는', () => {
  it('⭐받침 있음 → 은(story #3824 회귀 재현 — "채팅"은 원래 이 갈래였다)', () => {
    expect(pickEunNeunJosa('채팅')).toBe('은'); // 팅=ㅇ받침
    expect(pickEunNeunJosa('알림')).toBe('은'); // 림=ㅁ받침
  });

  it('⭐받침 없음 → 는(story #3824 실사고 — "대화"가 이 갈래인데 하드코딩 "은"이 걸렸다)', () => {
    expect(pickEunNeunJosa('대화')).toBe('는'); // 화=받침없음
    expect(pickEunNeunJosa('보드')).toBe('는'); // 드=받침없음
  });

  it('ㄹ받침도 은(으로/로와 달리 은/는엔 ㄹ 예외가 없다)', () => {
    expect(pickEunNeunJosa('실험실')).toBe('은'); // 실=ㄹ받침
  });

  it('완성형 한글이 없으면 받침 없는 것과 동일하게 는으로 안전 폴백', () => {
    expect(pickEunNeunJosa('Project')).toBe('는');
    expect(pickEunNeunJosa('')).toBe('는');
  });
});

// story #3900(UX-v3·§⑤ 어조 가드 사각 3) — 「{name}이/가」·「{title}을/를」 고정 조사(값 받침에
// 따라 비문) 수정. 은/는과 같은 규칙(받침 有→이/을·받침 無→가/를·ㄹ 예외 없음).
describe('pickIGaJosa — 받침 유무에 따른 이/가', () => {
  it('받침 있음 → 이', () => {
    expect(pickIGaJosa('디캄포')).toBe('가'); // 포=받침없음(대조)
    expect(pickIGaJosa('미르코')).toBe('가'); // 코=받침없음
    expect(pickIGaJosa('디디')).toBe('가'); // 디=받침없음
    expect(pickIGaJosa('올리베이라')).toBe('가'); // 라=받침없음
    expect(pickIGaJosa('카디르')).toBe('가'); // 르=받침없음
    expect(pickIGaJosa('김')).toBe('이'); // 김=ㅁ받침
    expect(pickIGaJosa('담롱')).toBe('이'); // 롱=ㅇ받침
  });

  it('ㄹ받침도 이(은/는과 동일·으로/로와 달리 ㄹ 예외 없음)', () => {
    expect(pickIGaJosa('메일')).toBe('이'); // 일=ㄹ받침
  });

  it('완성형 한글이 없으면 받침 없는 것과 동일하게 가로 안전 폴백', () => {
    expect(pickIGaJosa('GA4')).toBe('가');
    expect(pickIGaJosa('')).toBe('가');
  });
});

describe('pickEulReulJosa — 받침 유무에 따른 을/를', () => {
  it('받침 있음 → 을', () => {
    expect(pickEulReulJosa('런타임')).toBe('을'); // 임=ㅁ받침
    expect(pickEulReulJosa('제목')).toBe('을'); // 목=ㄱ받침
  });

  it('받침 없음 → 를', () => {
    expect(pickEulReulJosa('스토리')).toBe('를'); // 리=받침없음
    expect(pickEulReulJosa('문서')).toBe('를'); // 서=받침없음
  });

  it('ㄹ받침도 을', () => {
    expect(pickEulReulJosa('파일')).toBe('을'); // 일=ㄹ받침
  });

  it('완성형 한글이 없으면 받침 없는 것과 동일하게 를로 안전 폴백', () => {
    expect(pickEulReulJosa('Claude')).toBe('를');
    expect(pickEulReulJosa('')).toBe('를');
  });
});

// story #4120(PO 실측, 2026-09-21) — 숫자 끝(0/1/3/6/7/8=받침 有·2/4/5/9=받침 無, 한글
// 숫자 읽기 고유 소리)이 이전엔 "완성형 한글 아님"으로 뭉뚱그려져 전부 받침 없음 취급이었다
// (referenceCandidatePromptStory 등 `#2249`류 숫자 토큰이 실사례) — 4종 피커 전부 공유하는
// hasBatchim이 이제 이 표를 따른다.
describe('숫자 끝 — 받침 有/無 한글 숫자 읽기 표(4종 피커 공유)', () => {
  it('받침 有(0/1/3/6/7/8)', () => {
    expect(pickIGaJosa('버전0')).toBe('이'); // 영=ㅇ받침
    expect(pickEulReulJosa('#2251')).toBe('을'); // 일=ㄹ받침
    expect(pickEunNeunJosa('v3')).toBe('은'); // 삼=ㅁ받침
    expect(pickIGaJosa('v6')).toBe('이'); // 육=ㄱ받침
    expect(pickEulReulJosa('v7')).toBe('을'); // 칠=ㄹ받침
    expect(pickEunNeunJosa('v8')).toBe('은'); // 팔=ㄹ받침
  });

  it('받침 無(2/4/5/9)', () => {
    expect(pickIGaJosa('v2')).toBe('가'); // 이=받침없음
    expect(pickEulReulJosa('v4')).toBe('를'); // 사=받침없음
    expect(pickEunNeunJosa('v5')).toBe('는'); // 오=받침없음
    expect(pickIGaJosa('v9')).toBe('가'); // 구=받침없음
  });
});
