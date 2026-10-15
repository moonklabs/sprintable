// [SID:4681] (D3 · piece ③ · PO 5067 review): a folder on a Mac, with the home folder written as `~` — the one shape a path takes when
// it leaves this computer (the project's `workdir_hint` the whole organization reads · the setup's defaultWorkdirHint is `~/…` too)
// or is shown to a person. The Mac user's name never rides in it. The app's own hands (`setProjectFolder`) keep the absolute path.

/** `/Users/<name>/x` → `~/x` · `/Users/<name>` → `~` · anything else as it is */
export function homeAsTilde(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
}
