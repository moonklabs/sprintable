import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { getInternalDogfoodActors, isInternalDogfoodEnabled, readInternalDogfoodSession, resolveInternalDogfoodActor } from '@/lib/internal-dogfood';

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function readString(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function InternalDogfoodPage({ searchParams }: PageProps) {
  if (!isInternalDogfoodEnabled()) notFound();

  const params = searchParams ? await searchParams : {};
  const error = readString(params.error);
  const createdMemoId = readString(params.created_memo_id);
  const createdStoryId = readString(params.created_story_id);
  const signedOut = readString(params.signed_out);

  const actors = getInternalDogfoodActors();
  const session = await readInternalDogfoodSession();
  const actor = session ? resolveInternalDogfoodActor(session.teamMemberId) : null;

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          eyebrow="Internal dogfood"
          title="Sprintable emergency memo / story intake"
          description="인증 플레인 장애 중에도 Moonlabs 내부 인력이 Sprintable에서 직접 메모와 스토리를 생성하기 위한 임시 진입점인"
          actions={actor ? (
            <form action="/api/internal-dogfood/sign-out" method="post">
              <Button type="submit" variant="outline">세션 종료</Button>
            </form>
          ) : null}
        />

        {signedOut ? (
          <SectionCard>
            <SectionCardBody>
              <p className="text-sm text-emerald-700">내부 dogfood 세션 종료 완료한.</p>
            </SectionCardBody>
          </SectionCard>
        ) : null}

        {error ? (
          <SectionCard>
            <SectionCardBody>
              <p className="text-sm text-rose-700">오류: {error}</p>
            </SectionCardBody>
          </SectionCard>
        ) : null}

        {createdMemoId || createdStoryId ? (
          <SectionCard>
            <SectionCardHeader>
              <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">생성 결과</div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-2 text-sm text-[color:var(--operator-muted)]">
              {createdMemoId ? <div>memo created: <span className="font-mono text-[color:var(--operator-foreground)]">{createdMemoId}</span></div> : null}
              {createdStoryId ? <div>story created: <span className="font-mono text-[color:var(--operator-foreground)]">{createdStoryId}</span></div> : null}
            </SectionCardBody>
          </SectionCard>
        ) : null}

        {!actor ? (
          <SectionCard>
            <SectionCardHeader>
              <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">내부 세션 열기</div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-4">
              {actors.length ? (
                <form action="/api/internal-dogfood/session" method="post" className="space-y-4">
                  <div className="space-y-2">
                    <label htmlFor="team_member_id" className="block text-sm font-medium text-gray-700">내부 계정</label>
                    <select id="team_member_id" name="team_member_id" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" defaultValue={actors[0]?.id}>
                      {actors.map((item) => (
                        <option key={item.id} value={item.id}>{item.name} · {item.project_name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="secret" className="block text-sm font-medium text-gray-700">공유 시크릿</label>
                    <input id="secret" name="secret" type="password" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" placeholder="internal access secret" required />
                  </div>
                  <Button type="submit">내부 세션 시작</Button>
                </form>
              ) : (
                <EmptyState title="허용된 내부 계정이 아직 없음" description="INTERNAL_DOGFOOD_TEAM_MEMBER_IDS 환경 변수를 먼저 채워야 하는." />
              )}
            </SectionCardBody>
          </SectionCard>
        ) : (
          <>
            <SectionCard>
              <SectionCardHeader>
                <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">현재 세션</div>
              </SectionCardHeader>
              <SectionCardBody className="grid gap-2 text-sm text-[color:var(--operator-muted)] md:grid-cols-2">
                <div>actor: <span className="font-medium text-[color:var(--operator-foreground)]">{actor.name}</span></div>
                <div>project: <span className="font-medium text-[color:var(--operator-foreground)]">{actor.project_name}</span></div>
                <div>team member id: <span className="font-mono text-[color:var(--operator-foreground)]">{actor.id}</span></div>
                <div>project id: <span className="font-mono text-[color:var(--operator-foreground)]">{actor.project_id}</span></div>
              </SectionCardBody>
            </SectionCard>

            <div className="grid gap-6 lg:grid-cols-2">
              <SectionCard>
                <SectionCardHeader>
                  <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">메모 생성</div>
                </SectionCardHeader>
                <SectionCardBody>
                  <form action="/api/internal-dogfood/memos" method="post" className="space-y-4">
                    <div className="space-y-2">
                      <label htmlFor="memo-title" className="block text-sm font-medium text-gray-700">제목</label>
                      <input id="memo-title" name="title" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" placeholder="예: [PO][BE] blocker 확인" />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="memo-type" className="block text-sm font-medium text-gray-700">memo_type</label>
                      <input id="memo-type" name="memo_type" defaultValue="memo" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="memo-assigned" className="block text-sm font-medium text-gray-700">담당자 team member id</label>
                      <input id="memo-assigned" name="assigned_to" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" placeholder="예: 9cac9d96-5474-45f7-941e-787407597b52" />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="memo-content" className="block text-sm font-medium text-gray-700">내용</label>
                      <textarea id="memo-content" name="content" required rows={8} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" placeholder="메모 내용" />
                    </div>
                    <Button type="submit">메모 생성</Button>
                  </form>
                </SectionCardBody>
              </SectionCard>

              <SectionCard>
                <SectionCardHeader>
                  <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">스토리 생성</div>
                </SectionCardHeader>
                <SectionCardBody>
                  <form action="/api/internal-dogfood/stories" method="post" className="space-y-4">
                    <div className="space-y-2">
                      <label htmlFor="story-title" className="block text-sm font-medium text-gray-700">제목</label>
                      <input id="story-title" name="title" required className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" placeholder="예: Sprintable communication migration blocker" />
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <label htmlFor="story-status" className="block text-sm font-medium text-gray-700">상태</label>
                        <select id="story-status" name="status" defaultValue="backlog" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                          <option value="backlog">backlog</option>
                          <option value="ready-for-dev">ready-for-dev</option>
                          <option value="in-progress">in-progress</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="story-priority" className="block text-sm font-medium text-gray-700">우선순위</label>
                        <select id="story-priority" name="priority" defaultValue="medium" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                          <option value="low">low</option>
                          <option value="medium">medium</option>
                          <option value="high">high</option>
                          <option value="urgent">urgent</option>
                        </select>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="story-assignee" className="block text-sm font-medium text-gray-700">담당자 team member id</label>
                      <input id="story-assignee" name="assignee_id" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" placeholder="예: cff9055b-c671-4401-8436-a17f804a0406" />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="story-description" className="block text-sm font-medium text-gray-700">설명</label>
                      <textarea id="story-description" name="description" rows={8} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" placeholder="스토리 설명" />
                    </div>
                    <Button type="submit">스토리 생성</Button>
                  </form>
                </SectionCardBody>
              </SectionCard>
            </div>
          </>
        )}

        <SectionCard>
          <SectionCardBody className="text-sm text-[color:var(--operator-muted)]">
            이 경로는 임시 Moonlabs 내부 dogfooding 전용인. auth plane 복구 후 env flag를 내리면 바로 비활성화되는 구조인.
            {' '}
            <Link href="/login" className="text-[color:var(--operator-primary-soft)] underline">일반 로그인 페이지로 이동</Link>
          </SectionCardBody>
        </SectionCard>
      </div>
    </div>
  );
}
