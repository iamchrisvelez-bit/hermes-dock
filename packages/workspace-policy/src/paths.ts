import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathPolicyError';
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,100}$/;

/**
 * Join internal path segments under `root`, refusing anything that could escape it.
 * Segments must be internal identifiers (never user-supplied filenames).
 */
export function resolveInside(root: string, ...segments: string[]): string {
  for (const s of segments) {
    if (!SAFE_SEGMENT.test(s) || s.includes('..')) throw new PathPolicyError(`Unsafe path segment: ${JSON.stringify(s)}`);
  }
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, ...segments);
  const rel = path.relative(absRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new PathPolicyError('Path escapes its root');
  return target;
}

/** Throw if any existing component between root and target is a symlink. */
export function assertNoSymlinks(root: string, target: string): void {
  const absRoot = path.resolve(root);
  const rel = path.relative(absRoot, path.resolve(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new PathPolicyError('Path escapes its root');
  let cur = absRoot;
  const check = (p: string) => {
    try {
      if (lstatSync(p).isSymbolicLink()) throw new PathPolicyError(`Symlink refused: ${path.relative(absRoot, p) || '.'}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
  };
  check(cur);
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    check(cur);
  }
}

/** Per-project directory layout. Raw input is kept apart from generated output. */
export interface ProjectDirs {
  root: string;
  input: string;
  workspace: string;
  deliverables: string;
  partial: string;
  meta: string;
}

export function projectDirs(dataRoot: string, projectId: string): ProjectDirs {
  const root = resolveInside(dataRoot, 'projects', projectId);
  return {
    root,
    input: resolveInside(root, 'input'),
    workspace: resolveInside(root, 'workspace'),
    deliverables: resolveInside(root, 'deliverables'),
    partial: resolveInside(root, 'partial'),
    meta: resolveInside(root, 'meta'),
  };
}

export function ensureProjectDirs(dataRoot: string, projectId: string): ProjectDirs {
  mkdirSync(path.resolve(dataRoot), { recursive: true, mode: 0o700 });
  const dirs = projectDirs(dataRoot, projectId);
  for (const d of [dirs.root, dirs.input, dirs.workspace, dirs.deliverables, dirs.partial, dirs.meta]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  assertNoSymlinks(dataRoot, dirs.root);
  // Resolve once more after creation: the real path must still live under the data root.
  const realRoot = realpathSync(path.resolve(dataRoot));
  const realProj = realpathSync(dirs.root);
  if (!realProj.startsWith(realRoot + path.sep)) throw new PathPolicyError('Project directory resolved outside data root');
  return dirs;
}
