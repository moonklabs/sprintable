/**
 * story #3844 QA 계약값(PO, 2026-09-14) — FE task.status 리터럴(work-list/derive-work-list.ts
 * TASK_STATUS_VALUES)과 BE 정본(backend/sprintable_mcp/schemas.py::TaskStatus enum, DB
 * tasks_status_check와 동형)의 소스 대조. 라이브 검증 中 FE가 'in_progress'(언더스코어)로
 * 잘못 비교해 실 DB 값 'in-progress'(하이픈)를 한 건도 못 잡던 실사고(유닛테스트 fixture도
 * 같은 오탈자라 그린으로 통과) 재발 방지 — 손으로 친 리터럴이 다시 표류하지 못하게, CI가
 * 매번 두 소스를 직접 대조한다(전수 grep 0 불일치).
 */
import fs from 'node:fs';
import path from 'node:path';

/** `class {className}(str, Enum):` 바로 아래 들여쓰기된 멤버 줄들에서 `= "..."` 값만
 * 순서대로 뽑는다. 클래스가 파일 맨 끝이어도(뒤 빈 줄 개수 무관) 안전 — 첫 비들여쓰기
 * 줄에서 멈춘다. 클래스를 못 찾으면 빈 배열(호출부가 completeness로 FAIL 처리). */
export function extractPythonEnumValues(content: string, className: string): string[] {
  const classRe = new RegExp(`class ${className}\\(str, Enum\\):\\n((?:[ \\t]+.+\\n?)+)`, 'm');
  const match = classRe.exec(content);
  if (!match) return [];
  const body = match[1] ?? '';
  const values: string[] = [];
  const valueRe = /=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = valueRe.exec(body)) !== null) values.push(m[1] ?? '');
  return values;
}

export interface TaskStatusParityResult {
  /** BE엔 있는데 FE TASK_STATUS_VALUES엔 없는 값 — FE가 그 상태를 영영 못 잡는다. */
  missing: string[];
  /** FE엔 있는데 BE 정본엔 없는 값 — 죽은 코드거나 오탈자. */
  extra: string[];
}

export function compareTaskStatusValues(feValues: readonly string[], beValues: string[]): TaskStatusParityResult {
  const feSet = new Set(feValues);
  const beSet = new Set(beValues);
  return {
    missing: beValues.filter((v) => !feSet.has(v)),
    extra: feValues.filter((v) => !beSet.has(v)),
  };
}

export function readBeTaskStatusValues(backendRoot: string): string[] {
  const filePath = path.join(backendRoot, 'sprintable_mcp/schemas.py');
  const content = fs.readFileSync(filePath, 'utf-8');
  return extractPythonEnumValues(content, 'TaskStatus');
}
