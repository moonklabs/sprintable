// story 5031 (C1 step 5a · PO 11-27) — the path the desktop top bar draws on its left: «조직 › 프로젝트 › 지금 화면» (a place's screen: «조직 › 설정 › 지금 칸»).
// ONE rule for every screen: organization · then WHERE the screen lives — the project when the screen is project-scoped (its route is /[ws]/[proj]/…), else the place's name (홈 · 채팅 · 에이전트 · 설정, lib/nav-depth1 · nav-placement.json) · then the screen's own title
// (what the screen already publishes through the top bar's title slot — drawn by the bar itself, so a screen's heading semantics are never copied). This file is only the part before the title.
// A part that is not known is left out, never made up (no organization name yet → no organization crumb). The place's name is left out when the screen's title already says it (the first screen of 에이전트 is titled «에이전트»).
import type { ReactNode } from 'react';
import { isValidElement } from 'react';
import { placementRouteForPath } from './nav-depth1';
import { DEPTH1_ITEMS, ROUTE_PLACEMENT, type Depth1Id } from './nav-placement';

const PROJECT_ROUTE_PREFIX = '/[ws]/[proj]/';

export type PathScope = { kind: 'project' } | { kind: 'place'; place: Depth1Id } | { kind: 'none' };

/** Where a pathname lives for the path: a project-scoped screen · one of the four places · neither (login · public · an unknown route). */
export function pathScopeFor(pathname: string): PathScope {
  const route = placementRouteForPath(pathname);
  if (!route) return { kind: 'none' };
  if (route.startsWith(PROJECT_ROUTE_PREFIX)) return { kind: 'project' };
  const slot = ROUTE_PLACEMENT[route]?.slot;
  return slot && slot !== 'outside' ? { kind: 'place', place: slot } : { kind: 'none' };
}

/** The plain text a title slot's node carries (strings and numbers inside elements · arrays) — used only to notice «the title already says the place's name». A component that renders on its own (a function element) has no text here. */
export function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return typeof node.type === 'string' ? nodeText((node.props as { children?: ReactNode }).children) : '';
  return '';
}

export interface PathCrumb {
  key: 'org' | 'project' | 'place';
  label: string;
  /** where pressing it goes; none for the project (the project switcher lives in the icon bar's account) */
  href?: string;
}

export interface LeadingCrumbsInput {
  pathname: string;
  orgName?: string;
  projectName?: string;
  /** the name of one of the four places (the caller's translator) */
  placeName: (place: Depth1Id) => string;
  /** the first screen of one of the four places (the caller adds the project parameter) */
  placeHref: (place: Depth1Id) => string;
  /** the text of the screen's own title (nodeText of the slot's title), to avoid saying the place's name twice */
  titleText?: string;
}

/** The crumbs BEFORE the screen's own title. */
export function leadingCrumbs({ pathname, orgName, projectName, placeName, placeHref, titleText }: LeadingCrumbsInput): PathCrumb[] {
  const out: PathCrumb[] = [];
  if (orgName) out.push({ key: 'org', label: orgName, href: placeHref('home') });
  const scope = pathScopeFor(pathname);
  if (scope.kind === 'project') {
    if (projectName) out.push({ key: 'project', label: projectName });
  } else if (scope.kind === 'place') {
    const label = placeName(scope.place);
    if (label !== (titleText ?? '').trim()) out.push({ key: 'place', label, href: placeHref(scope.place) });
  }
  return out;
}

/** The first screen of a place (static, workspace-less path). */
export function placeFirstPath(place: Depth1Id): string {
  return DEPTH1_ITEMS.find((d) => d.id === place)!.path;
}
