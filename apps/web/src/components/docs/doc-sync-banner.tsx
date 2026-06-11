'use client';

import { AlertTriangle, RotateCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export interface DocSyncBannerLabels {
  /** Banner title — statusRemoteChanged / statusConflict. */
  title: string;
  /** Reload-latest action — conflictReload. */
  pull: string;
  /** Force-overwrite action — conflictOverwrite. */
  overwrite: string;
  /** Dismiss action for remote-changed — syncKeepEditing. */
  keepEditing: string;
  /** Inline warning shown before a pull discards unsaved edits — syncDiscardWarning. */
  discardWarning: string;
  /** Confirm copy for the destructive overwrite — syncOverwriteConfirm. */
  overwriteConfirm: string;
}

/**
 * Off-ramp banner for the editor's unresolved sync states (story fc4d4264 FIX-4).
 * Replaces the dead-end where `conflict` / `remote-changed` showed status only, with
 * no way out but a refresh that silently dropped local edits. Non-blocking Alert that
 * always offers an exit:
 *   - remote-changed → info  · [keep editing] · [reload latest]   (role="status")
 *   - conflict       → warning · [reload latest] · [overwrite mine] (role="alert")
 * Destructive intent ("overwrite", which loses the remote changes) is confined to a
 * single confirmed action. Colors come from the Alert/Button design tokens only.
 */
export function DocSyncBanner({
  status,
  isDirty,
  onPull,
  onOverwrite,
  onDismiss,
  labels,
}: {
  status: 'remote-changed' | 'conflict';
  isDirty: boolean;
  onPull: () => void | Promise<void>;
  onOverwrite: () => void | Promise<void>;
  onDismiss?: () => void;
  labels: DocSyncBannerLabels;
}) {
  const isConflict = status === 'conflict';

  const handleOverwrite = () => {
    // Single destructive confirmation point — the remote changes are lost on overwrite.
    if (window.confirm(labels.overwriteConfirm)) void onOverwrite();
  };

  // remote-changed surfaces the discard warning only when there is something to lose;
  // conflict always implies local edits, so it always shows it.
  const showDiscardWarning = isConflict || isDirty;

  return (
    <Alert variant={isConflict ? 'warning' : 'info'} role={isConflict ? 'alert' : 'status'}>
      {isConflict ? <AlertTriangle className="size-4" /> : <RotateCw className="size-4" />}
      <AlertTitle>{labels.title}</AlertTitle>
      {showDiscardWarning && <AlertDescription>{labels.discardWarning}</AlertDescription>}
      <div className="col-start-2 mt-2 flex flex-wrap gap-2">
        {isConflict ? (
          <>
            <Button size="sm" variant="default" onClick={() => void onPull()}>
              {labels.pull}
            </Button>
            <Button size="sm" variant="destructive" onClick={handleOverwrite}>
              {labels.overwrite}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="default" onClick={() => void onPull()}>
              {labels.pull}
            </Button>
            {onDismiss && (
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                {labels.keepEditing}
              </Button>
            )}
          </>
        )}
      </div>
    </Alert>
  );
}
