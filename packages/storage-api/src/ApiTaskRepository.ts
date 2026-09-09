import type { ITaskRepository, Task, CreateTaskInput, UpdateTaskInput, TaskListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

// story #3713(라이브 결함, 유나 배포 56 실측 02:40Z) — list() query 조립이 TaskListFilters의
// cursor·limit(+project_id·status_ne)을 안 실어 BE 커서가 전진하지 않았다(같은 5행·같은
// nextCursor 반복 — 「더 보기」가 kanban·epic-swimlane 둘 다 영영 무효였다).
//
// 재발 차단(memory: "extracted가 아니라 expected를 기준으로 검사해야 조용한 누락을 잡는다") —
// 이 상수가 TaskListFilters의 «모든» 키를 강제한다. `Record<keyof TaskListFilters, true>`라
// 인터페이스에 필드가 추가/삭제되면 이 리터럴이 tsc에서 즉시 깨진다(하나라도 빠지면
// 타입 에러 — 사람이 기억해서 나열하는 게 아니라 컴파일러가 강제). list()의 query 조립과
// ApiTaskRepository.test.ts의 완전성 테스트 둘 다 이 상수를 SSOT로 삼는다.
//
// story #3713 후속(페드루 PO CHANGES) — 원래 이 상수에 days_since도 있었고 query에도
// 실어 보냈으나, BE tasks 라우터에 대응 파라미터가 없어 FastAPI가 조용히 버렸다 — 이
// 스토리가 막으려는 클래스를 FE→BE 경계에서 재현하는 꼴이라 SSOT는 «FE가 보내는 키 =
// BE가 받는 키»를 지켜야 한다는 원칙대로 은퇴시켰다(TaskListFilters도 같이 제거).
export const TASK_LIST_FILTER_KEYS: Record<keyof TaskListFilters, true> = {
  story_id: true, project_id: true, assignee_id: true, status: true, status_ne: true,
  ids: true, limit: true, cursor: true,
};

export class ApiTaskRepository implements ITaskRepository {
  constructor(private readonly accessToken: string = '') {}

  async create(input: CreateTaskInput): Promise<Task> {
    return fastapiCall<Task>('POST', '/api/v2/tasks', this.accessToken, { body: input });
  }

  async list(filters: TaskListFilters): Promise<Task[]> {
    return fastapiCall<Task[]>('GET', '/api/v2/tasks', this.accessToken, {
      query: {
        story_id: filters.story_id,
        // story #3713 — BE(tasks.py:97)는 이미 project_id 필터를 받는데(story #2706)
        // 이 query 객체엔 없었다(q 소실 083176e8과 같은 클래스).
        project_id: filters.project_id,
        assignee_id: filters.assignee_id,
        status: filters.status,
        // story #3713 — BE(tasks.py:106)는 이미 status_ne를 받는데(get_overdue_tasks가
        // 이미 씀) 이 query 객체엔 없었다.
        status_ne: filters.status_ne,
        // story #2262 PR②(BE #2905) — story ids(ca37b2b0)와 동일 계약, comma-separated.
        ids: filters.ids?.join(','),
        // story #3713(라이브 결함) — cursor/limit이 빠져 있어 BE 커서가 전진하지 않았다
        // (같은 5행 반복) — Story 리포지토리와 동형으로 추가.
        limit: filters.limit,
        cursor: filters.cursor,
      },
    });
  }

  async getById(id: string, _scope?: RepositoryScopeContext): Promise<Task> {
    return fastapiCall<Task>('GET', `/api/v2/tasks/${id}`, this.accessToken);
  }

  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    return fastapiCall<Task>('PATCH', `/api/v2/tasks/${id}`, this.accessToken, { body: input });
  }

  async delete(id: string, _orgId: string): Promise<void> {
    await fastapiCall<void>('DELETE', `/api/v2/tasks/${id}`, this.accessToken);
  }
}
