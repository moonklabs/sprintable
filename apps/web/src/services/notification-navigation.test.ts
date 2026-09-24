import { describe, expect, it } from 'vitest';
import { attachNotificationHrefs } from './notification-navigation';

const n = (reference_type: string | null, reference_id: string | null, extra: Record<string, unknown> = {}) =>
  ({ id: `${reference_type}-${reference_id}`, reference_type, reference_id, ...extra });

describe('attachNotificationHrefs', () => {
  it('⭐게이트 알림은 게이트 대상의 프로젝트(target_project_id)를 싣는다 — 다른 프로젝트 게이트여도 셸 = 게이트 프로젝트(story #4244)', () => {
    const [gate] = attachNotificationHrefs([n('gate', 'g-1', { target_project_id: 'proj-B' })]);
    expect(gate!.href).toBe('/gates/g-1?p=proj-B');
  });

  it('⭐문서 알림은 BE가 해소한 slug로 그 문서를 연다(목록 아님) · 대상 프로젝트를 싣는다(story #4244)', () => {
    const [doc] = attachNotificationHrefs([n('doc', 'doc-1', { target_project_id: 'proj-C', target_doc_slug: 'ops-guide' })]);
    expect(doc!.href).toBe('/docs/ops-guide?p=proj-C');
  });

  it('slug가 없으면(삭제된 문서 · 옛 행) 대상 프로젝트의 문서 목록으로 · doc_comment 옛 행도 목록으로', () => {
    const [doc, comment] = attachNotificationHrefs([
      n('doc', 'doc-2', { target_project_id: 'proj-C', target_doc_slug: null }),
      n('doc_comment', 'comment-1'),
    ]);
    expect(doc!.href).toBe('/docs?p=proj-C');
    expect(comment!.href).toBe('/docs');
  });

  it('⭐대상 프로젝트를 모르면(조직 단위 · 해소 불가 · 옛 응답) 주소를 그대로 둔다 — 틀린 p를 만들지 않는다', () => {
    const [gate, story] = attachNotificationHrefs([
      n('gate', 'g-2', { target_project_id: null }),
      n('story', 's-1'),
    ]);
    expect(gate!.href).toBe('/gates/g-2');
    expect(story!.href).toBe('/board?story=s-1');
  });

  it('board 딥링크(task/story) · sprints 링크도 대상 프로젝트를 싣는다(story a539c649 S3d 회귀가드 유지)', () => {
    const [task, story, sprint] = attachNotificationHrefs([
      n('task', 't-1', { target_project_id: 'P' }),
      n('story', 's-1', { target_project_id: 'P' }),
      n('sprint', 'sp-1', { target_project_id: 'P' }),
    ]);
    expect(task!.href).toBe('/board?task_id=t-1&p=P');
    expect(story!.href).toBe('/board?story=s-1&p=P');
    expect(sprint!.href).toBe('/sprints?p=P');
  });

  it('memo(은퇴 경로 · story #2379) · 모르는 종류 · reference_id 없음은 href null', () => {
    const out = attachNotificationHrefs([n('memo', 'm-1'), n('team_member', 'tm-1', { target_project_id: null }), n('gate', null)]);
    expect(out.map((x) => x.href)).toEqual([null, null, null]);
  });
});
