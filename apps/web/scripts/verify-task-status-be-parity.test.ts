import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_STATUS_VALUES } from '../src/components/work-list/derive-work-list';
import { compareTaskStatusValues, extractPythonEnumValues, readBeTaskStatusValues } from './verify-task-status-be-parity';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../backend');

describe('extractPythonEnumValues — 셀프테스트', () => {
  it('str Enum 클래스의 문자열 값을 순서대로 뽑는다', () => {
    const src = 'class TaskStatus(str, Enum):\n    todo = "todo"\n    in_progress = "in-progress"\n    done = "done"\n\n\nclass Other(str, Enum):\n    x = "x"\n';
    expect(extractPythonEnumValues(src, 'TaskStatus')).toEqual(['todo', 'in-progress', 'done']);
  });

  it('파일 맨 끝 클래스(뒤 빈 줄 없음)도 안전하게 멈춘다', () => {
    const src = 'class TaskStatus(str, Enum):\n    todo = "todo"\n    done = "done"';
    expect(extractPythonEnumValues(src, 'TaskStatus')).toEqual(['todo', 'done']);
  });

  it('⭐없는 클래스명은 빈 배열(조용히 통과가 아니라 호출부가 길이 0을 보고 FAIL해야 함)', () => {
    expect(extractPythonEnumValues('class Foo(str, Enum):\n    a = "a"\n\n\n', 'TaskStatus')).toEqual([]);
  });
});

describe('compareTaskStatusValues — 셀프테스트', () => {
  it('완전 일치면 둘 다 빈 배열', () => {
    expect(compareTaskStatusValues(['a', 'b'], ['a', 'b'])).toEqual({ missing: [], extra: [] });
  });

  it('BE에만 있는 값은 missing, FE에만 있는 값은 extra', () => {
    expect(compareTaskStatusValues(['a'], ['a', 'b'])).toEqual({ missing: ['b'], extra: [] });
    expect(compareTaskStatusValues(['a', 'c'], ['a'])).toEqual({ missing: [], extra: ['c'] });
  });
});

describe('실 소스 대조 — backend/sprintable_mcp/schemas.py::TaskStatus ↔ FE TASK_STATUS_VALUES (story #3844 QA 계약값)', () => {
  it('전수 grep 0 불일치', () => {
    const beValues = readBeTaskStatusValues(BACKEND_ROOT);
    // 완전성 fail-closed — 파싱 실패로 0건이면(BE 파일 구조가 바뀌어 정규식이 못 찾음)
    // "일치한다"로 조용히 넘어가지 않고 여기서 먼저 죽는다.
    expect(beValues.length).toBeGreaterThan(0);
    expect(compareTaskStatusValues(TASK_STATUS_VALUES, beValues)).toEqual({ missing: [], extra: [] });
  });

  // ⭐되돌리면 RED — PO 지시(2026-09-14)의 뮤테이션 잣대: derive-work-list.ts가
  // TASK_STATUS_IN_PROGRESS 상수 대신 손으로 친 'in_progress'(언더스코어) 리터럴로
  // 되돌아가면, 이 대조 자체가 아니라 derive-work-list.test.ts의 실측 회귀가드
  // ("DB CHECK 제약 실측") 가 먼저 잡는다 — 이 파일은 "FE가 아는 값의 집합"과 "BE가
  // 정의한 값의 집합"의 일치를, 저 파일은 "FE 비교 로직이 그 값을 실제로 쓰는가"를
  // 잡는다(같은 재발을 두 층에서 겹으로 막는다, 스스로 다시 표류 못 함).
});
