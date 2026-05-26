'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

interface WorkflowTriggerType {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  is_system: boolean;
  is_enabled: boolean;
}

export function WorkflowTriggerTypesSection() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');

  const [triggerTypes, setTriggerTypes] = useState<WorkflowTriggerType[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [newSlug, setNewSlug] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const refresh = async () => {
    const res = await fetch('/api/workflow-trigger-types');
    if (res.ok) {
      const json = await res.json() as WorkflowTriggerType[];
      setTriggerTypes(Array.isArray(json) ? json : []);
    }
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);

  const flashMessage = (type: 'success' | 'error', text: string) => {
    setActionMessage({ type, text });
    setTimeout(() => setActionMessage(null), 3000);
  };

  const handleToggle = async (tt: WorkflowTriggerType) => {
    setTogglingId(tt.id);
    try {
      const res = await fetch(`/api/workflow-trigger-types/${tt.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: !tt.is_enabled }),
      });
      if (res.ok) {
        await refresh();
      } else {
        flashMessage('error', t('workflowToggleError'));
      }
    } finally {
      setTogglingId(null);
    }
  };

  const handleSaveEdit = async (id: string) => {
    setSaving(id);
    try {
      const res = await fetch(`/api/workflow-trigger-types/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: editLabel.trim(), description: editDescription.trim() || null }),
      });
      if (res.ok) {
        setEditingId(null);
        await refresh();
        flashMessage('success', t('workflowSaved'));
      } else {
        flashMessage('error', t('workflowSaveError'));
      }
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/workflow-trigger-types/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setConfirmDeleteId(null);
        await refresh();
        flashMessage('success', t('workflowDeleted'));
      } else {
        flashMessage('error', t('workflowDeleteError'));
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreate = async () => {
    if (!newSlug.trim() || !newLabel.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/workflow-trigger-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: newSlug.trim(),
          label: newLabel.trim(),
          description: newDescription.trim() || null,
        }),
      });
      if (res.ok) {
        setNewSlug('');
        setNewLabel('');
        setNewDescription('');
        await refresh();
        flashMessage('success', t('workflowCreated'));
      } else if (res.status === 409) {
        setCreateError(t('workflowSlugDuplicate'));
      } else {
        setCreateError(t('workflowCreateError'));
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('workflowTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('workflowDescription')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {actionMessage ? (
          <Alert variant={actionMessage.type === 'success' ? 'success' : 'destructive'}>
            <AlertDescription>{actionMessage.text}</AlertDescription>
          </Alert>
        ) : null}

        {loading ? (
          <p className="text-sm text-muted-foreground">...</p>
        ) : (
          <div className="space-y-2">
            {triggerTypes.map((tt) => (
              <div key={tt.id} className="rounded-md border border-border bg-muted/30 px-3 py-3 text-sm">
                {editingId === tt.id ? (
                  <div className="space-y-2">
                    <OperatorInput
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      placeholder={t('workflowLabelPlaceholder')}
                    />
                    <OperatorInput
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder={t('workflowDescriptionPlaceholder')}
                    />
                    <div className="flex gap-2">
                      <Button variant="hero" size="sm" onClick={() => void handleSaveEdit(tt.id)} disabled={!editLabel.trim() || saving === tt.id}>
                        {saving === tt.id ? '...' : tc('save')}
                      </Button>
                      <Button variant="glass" size="sm" onClick={() => setEditingId(null)}>
                        {tc('cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-foreground">{tt.label}</span>
                        <code className="rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">{tt.slug}</code>
                        {tt.is_system ? <Badge variant="secondary">{t('workflowSystemBadge')}</Badge> : null}
                        {!tt.is_enabled ? <Badge variant="destructive">{t('workflowDisabled')}</Badge> : null}
                      </div>
                      {tt.description ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">{tt.description}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="glass"
                        size="sm"
                        onClick={() => void handleToggle(tt)}
                        disabled={togglingId === tt.id}
                      >
                        {togglingId === tt.id ? '...' : tt.is_enabled ? t('workflowDisableBtn') : t('workflowEnableBtn')}
                      </Button>
                      {!tt.is_system ? (
                        <>
                          <Button
                            variant="glass"
                            size="sm"
                            onClick={() => {
                              setEditingId(tt.id);
                              setEditLabel(tt.label);
                              setEditDescription(tt.description ?? '');
                            }}
                          >
                            {tc('edit')}
                          </Button>
                          {confirmDeleteId === tt.id ? (
                            <>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => void handleDelete(tt.id)}
                                disabled={deletingId === tt.id}
                              >
                                {deletingId === tt.id ? '...' : tc('confirm')}
                              </Button>
                              <Button variant="glass" size="sm" onClick={() => setConfirmDeleteId(null)}>
                                {tc('cancel')}
                              </Button>
                            </>
                          ) : (
                            <Button variant="glass" size="sm" onClick={() => setConfirmDeleteId(tt.id)}>
                              {tc('delete')}
                            </Button>
                          )}
                        </>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {triggerTypes.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                {t('workflowNoTypes')}
              </div>
            ) : null}
          </div>
        )}

        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-xs font-medium text-muted-foreground">{t('workflowAddType')}</p>
          <div className="grid gap-2 md:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <OperatorInput
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              placeholder={t('workflowSlugPlaceholder')}
            />
            <OperatorInput
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder={t('workflowLabelPlaceholder')}
            />
            <OperatorInput
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder={t('workflowDescriptionPlaceholder')}
            />
            <Button
              variant="hero"
              size="lg"
              onClick={() => void handleCreate()}
              disabled={!newSlug.trim() || !newLabel.trim() || creating}
            >
              {creating ? '...' : tc('add')}
            </Button>
          </div>
          {createError ? (
            <p className="text-xs text-destructive">{createError}</p>
          ) : null}
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}
