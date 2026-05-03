'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { KanbanStory, KanbanMember } from './types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface Task {
  id: string;
  title: string;
  status: string;
}

interface Comment {
  id: string;
  content: string;
  created_by: string;
  created_at: string;
}

interface Activity {
  id: string;
  activity_type: string;
  old_value: string | null;
  new_value: string | null;
  created_by: string;
  created_at: string;
}

interface StoryDetailPanelProps {
  story: KanbanStory;
  tasks: Task[];
  nextTasksCursor?: string | null;
  loadingMoreTasks?: boolean;
  onLoadMoreTasks?: () => void;
  onClose: () => void;
  onStoryUpdate?: (updated: KanbanStory) => void;
  memberMap?: Record<string, KanbanMember>;
  members?: KanbanMember[];
}

function taskTone(status: string) {
  if (status === 'done') return 'bg-emerald-300';
  if (status === 'in-progress') return 'bg-[color:var(--operator-primary)]';
  return 'bg-white/20';
}

function DescriptionViewer({ description }: { description: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        p: ({ children }) => <p className="mb-2 break-words text-sm leading-6 text-muted-foreground last:mb-0">{children}</p>,
        h1: ({ children }) => <h1 className="mb-2 text-lg font-bold text-foreground">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 text-base font-bold text-foreground">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 text-sm font-bold text-foreground">{children}</h3>,
        ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5 text-muted-foreground">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5 text-muted-foreground">{children}</ol>,
        li: ({ children }) => <li className="text-sm leading-6">{children}</li>,
        pre: ({ children }) => <pre className="mb-2 overflow-x-auto rounded-lg bg-muted p-3 text-[13px] text-foreground">{children}</pre>,
        code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px] text-foreground">{children}</code>,
        blockquote: ({ children }) => <blockquote className="mb-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{children}</a>,
        strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
        em: ({ children }) => <em className="italic text-muted-foreground">{children}</em>,
        hr: () => <hr className="my-2 border-border" />,
      }}
    >
      {description}
    </ReactMarkdown>
  );
}

export function StoryDetailPanel({ story, tasks, nextTasksCursor = null, loadingMoreTasks = false, onLoadMoreTasks, onClose, onStoryUpdate, memberMap = {}, members = [] }: StoryDetailPanelProps) {
  const t = useTranslations('board');
  const [comments, setComments] = useState<Comment[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [nextCommentsCursor, setNextCommentsCursor] = useState<string | null>(null);
  const [nextActivitiesCursor, setNextActivitiesCursor] = useState<string | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);
  const [loadingActivities, setLoadingActivities] = useState(false);
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const [loadingMoreActivities, setLoadingMoreActivities] = useState(false);
  const [commentInput, setCommentInput] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);

  // Edit state
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(story.title);
  const [savingTitle, setSavingTitle] = useState(false);

  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(story.description ?? '');
  const [savingDescription, setSavingDescription] = useState(false);

  const [editingAssignee, setEditingAssignee] = useState(false);
  const [savingAssignee, setSavingAssignee] = useState(false);

  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitleDraft(story.title);
    setDescriptionDraft(story.description ?? '');
  }, [story.id, story.title, story.description]);

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  const statusKeyMap: Record<string, 'backlog' | 'readyForDev' | 'inProgress' | 'inReview' | 'done'> = {
    backlog: 'backlog',
    'ready-for-dev': 'readyForDev',
    'in-progress': 'inProgress',
    'in-review': 'inReview',
    done: 'done',
  };
  const statusKey = statusKeyMap[story.status];
  const statusLabel = statusKey ? t(statusKey) : story.status;

  const patchStory = async (body: Record<string, unknown>): Promise<KanbanStory | null> => {
    const res = await fetch(`/api/stories/${story.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data as KanbanStory;
  };

  const handleSaveTitle = async () => {
    if (!titleDraft.trim() || titleDraft === story.title) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    const updated = await patchStory({ title: titleDraft.trim() });
    setSavingTitle(false);
    setEditingTitle(false);
    if (updated) onStoryUpdate?.({ ...story, title: updated.title });
  };

  const handleSaveAssignee = async (assigneeId: string | null) => {
    setSavingAssignee(true);
    setEditingAssignee(false);
    const updated = await patchStory({ assignee_id: assigneeId });
    setSavingAssignee(false);
    if (updated) onStoryUpdate?.({ ...story, assignee_id: assigneeId });
  };

  const handleSaveDescription = async () => {
    if (descriptionDraft === (story.description ?? '')) {
      setEditingDescription(false);
      return;
    }
    setSavingDescription(true);
    const updated = await patchStory({ description: descriptionDraft || null });
    setSavingDescription(false);
    setEditingDescription(false);
    if (updated) onStoryUpdate?.({ ...story, description: updated.description });
  };

  // Fetch comments
  useEffect(() => {
    async function fetchComments() {
      setLoadingComments(true);
      try {
        const res = await fetch(`/api/stories/${story.id}/comments?limit=20`);
        if (res.ok) {
          const json = await res.json();
          setComments(json.data ?? []);
          setNextCommentsCursor(json.meta?.nextCursor ?? null);
        }
      } catch {
        setComments([]);
      } finally {
        setLoadingComments(false);
      }
    }
    void fetchComments();
  }, [story.id]);

  // Fetch activities
  useEffect(() => {
    async function fetchActivities() {
      setLoadingActivities(true);
      try {
        const res = await fetch(`/api/stories/${story.id}/activities?limit=20`);
        if (res.ok) {
          const json = await res.json();
          setActivities(json.data ?? []);
          setNextActivitiesCursor(json.meta?.nextCursor ?? null);
        }
      } catch {
        setActivities([]);
      } finally {
        setLoadingActivities(false);
      }
    }
    void fetchActivities();
  }, [story.id]);

  // ESC 키로 닫기
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingTitle) { setEditingTitle(false); setTitleDraft(story.title); return; }
        if (editingDescription) { setEditingDescription(false); setDescriptionDraft(story.description ?? ''); return; }
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose, editingTitle, editingDescription, story.title, story.description]);

  const handleSubmitComment = async () => {
    if (!commentInput.trim() || submittingComment) return;

    setSubmittingComment(true);
    try {
      const res = await fetch(`/api/stories/${story.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: commentInput }),
      });

      if (res.ok) {
        const json = await res.json();
        setComments((prev) => [json.data, ...prev]);
        setCommentInput('');
      }
    } catch {
      // silent
    } finally {
      setSubmittingComment(false);
    }
  };

  const handleLoadMoreComments = async () => {
    if (!nextCommentsCursor || loadingMoreComments) return;

    setLoadingMoreComments(true);
    try {
      const res = await fetch(`/api/stories/${story.id}/comments?limit=20&cursor=${encodeURIComponent(nextCommentsCursor)}`);
      if (res.ok) {
        const json = await res.json();
        setComments((prev) => [...prev, ...(json.data ?? [])]);
        setNextCommentsCursor(json.meta?.nextCursor ?? null);
      }
    } finally {
      setLoadingMoreComments(false);
    }
  };

  const handleLoadMoreActivities = async () => {
    if (!nextActivitiesCursor || loadingMoreActivities) return;

    setLoadingMoreActivities(true);
    try {
      const res = await fetch(`/api/stories/${story.id}/activities?limit=20&cursor=${encodeURIComponent(nextActivitiesCursor)}`);
      if (res.ok) {
        const json = await res.json();
        setActivities((prev) => [...prev, ...(json.data ?? [])]);
        setNextActivitiesCursor(json.meta?.nextCursor ?? null);
      }
    } finally {
      setLoadingMoreActivities(false);
    }
  };

  const formatActivityMessage = (activity: Activity) => {
    const { activity_type, old_value, new_value } = activity;

    switch (activity_type) {
      case 'created':
        return `Created story: ${new_value}`;
      case 'status_changed':
        return `Changed status from ${old_value} to ${new_value}`;
      case 'assignee_changed':
        return old_value ? `Changed assignee` : `Assigned`;
      case 'title_changed':
        return `Changed title`;
      case 'epic_changed':
        return old_value ? `Changed epic` : `Added to epic`;
      case 'sprint_changed':
        return old_value ? `Moved to different sprint` : `Added to sprint`;
      default:
        return activity_type;
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:bg-transparent"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed inset-0 z-50 bg-background shadow-xl backdrop-blur-xl lg:inset-y-0 lg:left-auto lg:right-0 lg:w-full lg:max-w-3xl lg:border-l lg:border-border">
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between border-b border-border p-5">
          <div className="flex-1 space-y-2 pr-3">
            {editingTitle ? (
              <div className="space-y-2">
                <input
                  ref={titleInputRef}
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSaveTitle();
                  }}
                  className="w-full rounded-md border border-border bg-muted px-2 py-1 text-lg font-semibold text-foreground outline-none focus:ring-2 focus:ring-primary"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveTitle} disabled={savingTitle || !titleDraft.trim()}>
                    {savingTitle ? t('loading') : t('save')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setEditingTitle(false); setTitleDraft(story.title); }}>
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="group flex w-full items-start gap-1 text-left"
                onClick={() => setEditingTitle(true)}
              >
                <h2 className="text-lg font-semibold text-foreground">{story.title}</h2>
                <span className="mt-1 shrink-0 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">✎</span>
              </button>
            )}
            <StatusBadge status={story.status} label={statusLabel} />
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded-md border border-border px-3 py-2 text-muted-foreground transition hover:text-foreground hover:bg-muted/50">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <div className="space-y-5">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('status')}</span>
              <p className="mt-1 text-sm text-foreground">{statusLabel}</p>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('assignee')}</span>
                {!editingAssignee && (
                  <button
                    type="button"
                    onClick={() => setEditingAssignee(true)}
                    className="text-xs text-muted-foreground transition hover:text-foreground"
                  >
                    ✎ {t('edit')}
                  </button>
                )}
              </div>
              {editingAssignee ? (
                <div className="mt-1 flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-1">
                  <button
                    type="button"
                    onClick={() => handleSaveAssignee(null)}
                    className="w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
                  >
                    — {t('unassigned')}
                  </button>
                  {members.filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => handleSaveAssignee(m.id)}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${story.assignee_id === m.id ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground">
                        {m.name.slice(0, 2).toUpperCase()}
                      </span>
                      {m.name}
                      {story.assignee_id === m.id && <span className="ml-auto text-primary">✓</span>}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setEditingAssignee(false)}
                    className="mt-1 w-full rounded px-2 py-1 text-center text-xs text-muted-foreground hover:bg-muted"
                  >
                    {t('cancel')}
                  </button>
                </div>
              ) : (
                <p className="mt-1 text-sm text-foreground">
                  {savingAssignee ? t('loading') : story.assignee_id ? (memberMap[story.assignee_id]?.name ?? '—') : '—'}
                </p>
              )}
            </div>
            {story.story_points != null ? (
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('storyPoints')}</span>
                <p className="mt-1 text-sm text-foreground">{t('storyPointsBadge', { count: story.story_points })}</p>
              </div>
            ) : null}

            {/* Description */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('description')}</span>
                {!editingDescription && (
                  <button
                    type="button"
                    onClick={() => setEditingDescription(true)}
                    className="text-xs text-muted-foreground transition hover:text-foreground"
                  >
                    ✎ {t('edit')}
                  </button>
                )}
              </div>
              {editingDescription ? (
                <div className="mt-2 space-y-2">
                  <Textarea
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    placeholder="Markdown 형식으로 작성하세요..."
                    className="min-h-[160px] resize-y font-mono text-sm"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSaveDescription} disabled={savingDescription}>
                      {savingDescription ? t('loading') : t('save')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setEditingDescription(false); setDescriptionDraft(story.description ?? ''); }}>
                      {t('cancel')}
                    </Button>
                  </div>
                </div>
              ) : story.description ? (
                <div className="mt-2 cursor-pointer" onClick={() => setEditingDescription(true)}>
                  <DescriptionViewer description={story.description} />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingDescription(true)}
                  className="mt-2 w-full rounded-md border border-dashed border-border py-3 text-sm text-muted-foreground transition hover:border-primary hover:text-primary"
                >
                  + {t('addDescription')}
                </button>
              )}
            </div>

            {/* Tabs for Tasks, Comments, Activity */}
            <Tabs defaultValue="tasks" className="w-full">
              <TabsList className="w-full">
                <TabsTrigger value="tasks" className="flex-1">Tasks ({tasks.length})</TabsTrigger>
                <TabsTrigger value="comments" className="flex-1">Comments ({comments.length})</TabsTrigger>
                <TabsTrigger value="activity" className="flex-1">Activity</TabsTrigger>
              </TabsList>

              <TabsContent value="tasks" className="mt-4 space-y-2">
                {tasks.length === 0 ? (
                  <p className="text-sm text-[color:var(--operator-muted)]">{t('noTasks')}</p>
                ) : (
                  <>
                    <ul className="space-y-2">
                      {tasks.map((task) => (
                        <li key={task.id} className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                          <span className={`h-2.5 w-2.5 rounded-full ${taskTone(task.status)}`} />
                          <span className={task.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground'}>{task.title}</span>
                        </li>
                      ))}
                    </ul>
                    {nextTasksCursor ? (
                      <div className="mt-3 text-center">
                        <Button variant="outline" size="sm" onClick={onLoadMoreTasks} disabled={loadingMoreTasks || !onLoadMoreTasks}>
                          {loadingMoreTasks ? t('loading') : t('loadMore')}
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </TabsContent>

              <TabsContent value="comments" className="mt-4 space-y-4">
                {/* Comment input */}
                <div className="space-y-2">
                  <Textarea
                    placeholder="Add a comment..."
                    value={commentInput}
                    onChange={(e) => setCommentInput(e.target.value)}
                    className="min-h-[80px] resize-none"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        void handleSubmitComment();
                      }
                    }}
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      onClick={handleSubmitComment}
                      disabled={!commentInput.trim() || submittingComment}
                    >
                      {submittingComment ? t('loading') : 'Comment'}
                    </Button>
                  </div>
                </div>

                {/* Comments list */}
                {loadingComments ? (
                  <p className="text-sm text-[color:var(--operator-muted)]">{t('loading')}</p>
                ) : comments.length === 0 ? (
                  <p className="text-sm text-[color:var(--operator-muted)]">No comments yet</p>
                ) : (
                  <>
                    <ul className="space-y-3">
                      {comments.map((comment) => (
                        <li key={comment.id} className="rounded-md border border-border bg-muted/30 p-3">
                          <p className="whitespace-pre-wrap text-sm text-foreground">{comment.content}</p>
                          <p className="mt-2 text-[10px] font-mono text-muted-foreground">
                            {new Date(comment.created_at).toLocaleString()}
                          </p>
                        </li>
                      ))}
                    </ul>
                    {nextCommentsCursor ? (
                      <div className="text-center">
                        <Button variant="outline" size="sm" onClick={handleLoadMoreComments} disabled={loadingMoreComments}>
                          {loadingMoreComments ? t('loading') : t('loadMore')}
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </TabsContent>

              <TabsContent value="activity" className="mt-4 space-y-2">
                {loadingActivities ? (
                  <p className="text-sm text-[color:var(--operator-muted)]">{t('loading')}</p>
                ) : activities.length === 0 ? (
                  <p className="text-sm text-[color:var(--operator-muted)]">No activity yet</p>
                ) : (
                  <>
                    <ul className="space-y-2">
                      {activities.map((activity) => (
                        <li key={activity.id} className="rounded-md border border-border bg-muted/30 p-3">
                          <p className="text-sm text-foreground">{formatActivityMessage(activity)}</p>
                          <p className="mt-1 text-[10px] font-mono text-muted-foreground">
                            {new Date(activity.created_at).toLocaleString()}
                          </p>
                        </li>
                      ))}
                    </ul>
                    {nextActivitiesCursor ? (
                      <div className="text-center">
                        <Button variant="outline" size="sm" onClick={handleLoadMoreActivities} disabled={loadingMoreActivities}>
                          {loadingMoreActivities ? t('loading') : t('loadMore')}
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
