'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * story 4946 (the desktop app's room) — a FILE dragged over the room is received by the whole room, not only by the composer's own strip: the room column shows the drop guide while the file is over it, and a drop anywhere in it
 * goes to the composer as an attachment (`onFiles` — the same path the composer's own drop and the clip button take). Before this, a drop on the messages did nothing — and a page that does not say «I take drops» (`preventDefault` on
 * dragover) lets the browser OPEN the dropped file in place of the room (the storage screen guards against exactly that for the same reason).
 * The drag depth is counted (enter / leave fire on every child), the same way the document editor's drop zone does. A drop the composer already took (it calls `preventDefault` first, a child before its parent) is not added twice.
 */
export function useRoomFileDrop(onFiles: (files: File[]) => void) {
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const onDragEnter = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth.current += 1;
    setDragging(true);
  }, []);
  const onDragOver = useCallback((e: DragEvent) => {
    if (hasFiles(e)) e.preventDefault(); // «this takes the drop» — without it the browser opens the file
  }, []);
  const onDragLeave = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);
  const onDrop = useCallback((e: DragEvent) => {
    depth.current = 0;
    setDragging(false);
    if (!hasFiles(e)) return;
    const taken = e.defaultPrevented; // the composer's own strip took it (and added the files itself)
    e.preventDefault();
    if (taken) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onFiles(files);
  }, [onFiles]);
  // A file dropped on a part of the page that takes no drop (the thread panel's messages · a dialog) would be OPENED by the browser in place of the room — the page says «not here» (nothing is attached) instead.
  // The window listens last (bubbling): every part that takes drops (the composer's strip · the room) has already had it.
  useEffect(() => {
    const guard = (e: globalThis.DragEvent) => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => { window.removeEventListener('dragover', guard); window.removeEventListener('drop', guard); };
  }, []);
  return { dragging, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
