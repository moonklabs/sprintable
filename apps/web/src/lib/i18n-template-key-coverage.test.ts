// story #2228 — i18n-key-coverage 가드(#2210, i18n-key-coverage.test.ts)는 정적 문자열
// 리터럴 키만 본다. "템플릿 리터럴로 조합해서 만드는" 키(`t(\`status_${s}\`)` 같은 자리)는
// 정적 정규식으로 값을 못 구해 그 가드의 스캔 대상에서 빠진다.
//
// 2026-07-27 실측: apps/web/src 전체에서 그런 자리가 **55곳**(~20개 파일) — 바늘구멍이
// 아니었다. 그 55곳 전부를 소스에서 직접 읽어 "그 변수가 실제로 가질 수 있는 값"을
// TypeScript 유니온 타입·const 배열·순수함수의 반환값에서 전개했다(추측 금지 — 실제 값만).
//
// 결과: 아래 표로 커버되는 finite(유한) 자리 53곳 중 **2개 키가 실제로 누락**돼 있었다
// (agentHitl.escalationMode_timeout_memo · escalationMode_timeout_memo_and_escalate —
// agent-hitl-policy-editor.tsx의 타임아웃 클래스 에스컬레이션 모드 드롭다운, 지금 채움).
// 나머지는 전부 존재 확인됨.
//
// 2026-07-27 후속(story #2235, managed agent 앞단 전량 삭제) — 위 53곳 중 agent-deployment-wizard.tsx·
// agent-hitl-policy.ts·agent-deployment-console.ts 출처였던 항목(steps.*, agentHitl.*,
// healthStateLabel_*/healthStateBody_*/recoveryCueTitle_*/recoveryCueBody_*)은 그 소스 파일 자체가
// 삭제되며 표에서 함께 제거— 번역 키도 동일하게 삭제됨(전용 확인 후, 다른 화면 미사용).
//
// ⛔이 가드도 못 잡는 것 2곳(고의로 남김, "0~2곳이면 바늘구멍" 판정 — #2228 AC6):
//   ① outcome-result-card.tsx의 `metric_${result.metric}` — `MetricDefinition.metric`이
//      `string`(무제한)이고 `source`가 'ga4'|'manual'일 때 실제 GA4/수동 메트릭 이름은
//      4개 내부 메트릭(velocity 등)과 무관한 임의 문자열이다. 이건 "키를 더 채우는" 문제가
//      아니라 호출부 자체가 잘못됐다 — 별도 스토리 후보로 남긴다(이 파일에서 안 고침).
//   ② tool-permission-picker.tsx·recruiter-client.tsx의 `toolPermissions.groups.${key}` —
//      BE `/api/v2/mcp/toolset-catalog`가 SSOT라 그룹 키가 백엔드에서 늘어날 수 있다.
//      현재 알려진 17개(폴백 상수 `toolset-catalog.ts`) 전량은 아래 표로 커버되지만,
//      새 그룹이 백엔드에만 추가되면 컴파일 타임으로 못 잡는 자리로 남는다.
//
// story #3732(2026-09-22) — TEMPLATE_KEY_TABLE 자체는 lib/i18n-template-key-table.ts로
// 이관(이 파일 옛 주석이 이미 예고한 verify-no-unused-i18n-keys.ts 재사용처가 plain tsx
// CLI에서 이 .test.ts를 직접 import하면 아래 describe/it가 vitest 러너 밖에서 즉시
// 실행돼 깨지기 때문 — 값 복제 0, SSOT 위치만 이동). 이 테스트는 그 표를 re-import해
// 그대로 검증한다.
import { describe, expect, it } from 'vitest';
import ko from '../../messages/ko.json';
import en from '../../messages/en.json';
import { TEMPLATE_KEY_TABLE } from './i18n-template-key-table';

function hasKey(messages: unknown, dotted: string): boolean {
  const parts = dotted.split('.');
  let cur: unknown = messages;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null || !(p in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string';
}

describe('i18n 템플릿 리터럴 조합 키 커버리지 — 정적 가드 사각지대의 유한 부분집합 (#2228)', () => {
  it('전개된 조합 키가 전부 ko.json·en.json 양쪽에 존재한다', () => {
    const missing: string[] = [];
    for (const [prefix, values, source] of TEMPLATE_KEY_TABLE) {
      for (const v of values) {
        const key = `${prefix}${v}`;
        if (!hasKey(ko, key) || !hasKey(en, key)) missing.push(`${key}  (${source})`);
      }
    }
    if (missing.length > 0) {
      throw new Error(`조합 키 ${missing.length}개가 번역 파일에 없다:\n${missing.map((m) => `  ${m}`).join('\n')}`);
    }
    expect(missing).toEqual([]);
  });
});
