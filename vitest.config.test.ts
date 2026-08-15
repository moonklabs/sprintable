// story #2641 — isolate:false 재현 실측 기록. 원 발견(#3023 QA, 카디르)은 doc-content-
// renderer.test.tsx 간헐 RED(href="") — 재현 시도: 기본설정(isolate:true, 이 파일이 지키는
// 그 기본값·CI의 `pnpm vitest run`과 동일, .github/workflows/ci.yml에 특수 pool/isolate
// 플래그 없음) 전체 431파일/3460테스트 **11회 연속 100% GREEN**(재현율 0/11) — 원 증상은
// 오늘 코드베이스에서 재현 불가로 정직하게 닫는다(«고쳤다» 선언 아님, «재현 안 됨» 기록).
//
// 대신 isolate:false로 강제하면(비정상 설정, 이 가드가 막는 바로 그것) **진짜 크로스파일
// 오염이 확実히 재현**됐다 — 6회전 연속 시도(next-intl mock 완전화 적용 後에도) 매회
// 완전히 다른, 서로 무관한 파일들이 무작위로 깨졌다: 1건→52건→20건→12건→16건→2건
// (fastapi-proxy·embed-card·context-switcher-chip·use-unified-switcher·recruiter-client
// 계열·llm/client·sse-multiplexer·oauth-handoff·chat-proof-section 등, 서로 접점 없음).
// 원인: `vi.mock()`은 파일 경계 안에서만 유효하다는 게 vitest의 격리 전제인데, isolate:false는
// 이 전제를 깨 module registry를 워커 안 전 파일이 공유한다 — 400+파일 전수가 서로 잠재
// 충돌 상대가 되는 구조다. 소수 파일의 mock을 "완전화"(부족한 메서드 채우기)해도 다음 회차엔
// 전혀 다른 무관한 쌍이 깨져 「0건」 자체가 이 스코프에서 달성 불가능함이 실증됐다(전면
// mock 표준화=수주 단위 별건, 이 스토리 범위 밖 — 명시 제외).
//
// ⚠️이 가드가 못 잡는 것: vitest.config.ts 파일 자체의 `isolate` 키만 본다. CLI 플래그
// (`vitest run --isolate=false`)나 CI 워크플로 YAML의 별도 오버라이드는 이 정규식 밖이라
// 못 잡는다 — 그 경로로 isolate:false를 켜려는 시도가 있다면 이 파일과 story #2641을
// 먼저 읽을 것(코드 리뷰가 그 자리에서 이 기록을 인용해야 한다).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CONFIG_SOURCE = readFileSync(path.resolve(__dirname, 'vitest.config.ts'), 'utf-8');

describe('vitest.config.ts — isolate:false 금지 가드 (story #2641)', () => {
  it('test.isolate가 false로 설정되지 않는다(설정 시 400+파일 상호충돌 지뢰밭 — 위 주석의 6회전 실측 참고)', () => {
    expect(CONFIG_SOURCE).not.toMatch(/isolate\s*:\s*false/);
  });
});
