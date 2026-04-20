'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { KanbanStory } from './types';
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
}

function taskTone(status: string) {
  if (status === 'done') return 'bg-emerald-300';
  if (status === 'in-progress') return 'bg-[color:var(--operator-primary)]';
  return 'bg-white/20';
}

export function StoryDetailPanel({ story, tasks, nextTasksCursor = null, loadingMoreTasks = false, onLoadMoreTasks, onClose }: StoryDetailPanelProps) {
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

  const statusKeyMap: Record<string, 'backlog' | 'readyForDev' | 'inProgress' | 'inReview' | 'done'> = {
    backlog: 'backlog',
    'ready-for-dev': 'readyForDev',
    'in-progress': 'inProgress',
    'in-review': 'inReview',
    done: 'done',
  };
  const statusKey = statusKeyMap[story.status];
  const statusLabel = statusKey ? t(statusKey) : story.status;

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
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

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
      // Error handling could be added here
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
      <div className="fixed inset-0 z-50 bg-background shadow-xl backdrop-blur-xl lg:inset-y-0 lg:left-auto lg:right-0 lg:w-full lg:max-w-md lg:border-l lg:border-border">
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border p-5">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">{story.title}</h2>
            <StatusBadge status={story.status} label={statusLabel} />
          </div>
          <button onClick={onClose} className="rounded-md border border-border px-3 py-2 text-muted-foreground transition hover:text-foreground hover:bg-muted/50">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <div className="space-y-5">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('status')}</span>
              <p className="mt-1 text-sm text-foreground">{statusLabel}</p>
            </div>
            {story.story_points != null ? (
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('storyPoints')}</span>
                <p className="mt-1 text-sm text-foreground">{t('storyPointsBadge', { count: story.story_points })}</p>
              </div>
            ) : null}
            {story.description ? (
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('description')}</span>
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{story.description}</p>
              </div>
            ) : null}

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
