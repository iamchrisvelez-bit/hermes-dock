import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  OwnerPolicy,
  PathPolicyError,
  assertNoSymlinks,
  ensureProjectDirs,
  evaluate,
  resolveInside,
  sanitizeDisplayName,
  validateOne,
  validateUploads,
  type PolicyContext,
} from '../src/index.ts';

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  policy: DEFAULT_POLICY,
  controls: { pauseAll: false, newWorkDisabled: false, emergencyStop: false },
  sandbox: { executableWorkEnabled: false, reason: 'none verified' },
  ...over,
});

describe('policy decisions', () => {
  it('has safe defaults', () => {
    expect(DEFAULT_POLICY).toMatchObject({ maxConcurrentWorkers: 1, maxDelegationDepth: 1, maxReviewIterations: 3, unrestrictedShell: false });
    expect(() => OwnerPolicy.parse({ ...DEFAULT_POLICY, unrestrictedShell: true })).toThrow();
  });

  it('enforces concurrency, iteration and delegation limits', () => {
    expect(evaluate({ kind: 'start_task', runningWorkers: 1, iteration: 1, planApproved: true }, ctx()).outcome).toBe('deny');
    expect(evaluate({ kind: 'start_task', runningWorkers: 0, iteration: 4, planApproved: true }, ctx()).outcome).toBe('deny');
    expect(evaluate({ kind: 'start_task', runningWorkers: 0, iteration: 3, planApproved: true }, ctx()).outcome).toBe('allow');
    expect(evaluate({ kind: 'create_worker', delegationDepth: 2 }, ctx()).outcome).toBe('deny');
  });

  it('respects pause, new-work and emergency controls', () => {
    const paused = ctx({ controls: { pauseAll: true, newWorkDisabled: false, emergencyStop: false } });
    expect(evaluate({ kind: 'start_task', runningWorkers: 0, iteration: 1, planApproved: true }, paused).outcome).toBe('deny');
    const noNew = ctx({ controls: { pauseAll: false, newWorkDisabled: true, emergencyStop: false } });
    expect(evaluate({ kind: 'intake' }, noNew).outcome).toBe('deny');
    expect(evaluate({ kind: 'start_task', runningWorkers: 0, iteration: 1, planApproved: true }, noNew).outcome).toBe('allow');
    const stop = ctx({ controls: { pauseAll: true, newWorkDisabled: true, emergencyStop: true } });
    expect(evaluate({ kind: 'create_project' }, stop).outcome).toBe('deny');
  });

  it('observe tier never executes; assist tier needs approved plans', () => {
    const observe = ctx({ policy: { ...DEFAULT_POLICY, autonomyTier: 'observe' } });
    expect(evaluate({ kind: 'start_task', runningWorkers: 0, iteration: 1, planApproved: true }, observe).outcome).toBe('deny');
    expect(evaluate({ kind: 'create_island' }, observe).outcome).toBe('deny');
    const assist = ctx({ policy: { ...DEFAULT_POLICY, autonomyTier: 'assist' } });
    expect(evaluate({ kind: 'start_task', runningWorkers: 0, iteration: 1, planApproved: false }, assist)).toMatchObject({ outcome: 'requires_approval', approvalKind: 'task_plan' });
  });

  it('refuses host-executing and external Hermes toolsets even if allowlisted', () => {
    const permissive = ctx({ policy: { ...DEFAULT_POLICY, allowedHermesToolsets: ['terminal', 'delegation', 'web'] } });
    expect(evaluate({ kind: 'run_hermes', enabledToolsets: ['terminal'] }, permissive).outcome).toBe('deny');
    expect(evaluate({ kind: 'run_hermes', enabledToolsets: ['delegation'] }, permissive).outcome).toBe('deny');
    expect(evaluate({ kind: 'run_hermes', enabledToolsets: ['web'] }, permissive).outcome).toBe('allow');
    expect(evaluate({ kind: 'run_hermes', enabledToolsets: ['web'] }, ctx()).outcome).toBe('deny');
    expect(evaluate({ kind: 'run_hermes', enabledToolsets: [] }, ctx()).outcome).toBe('allow');
  });

  it('never enables code execution without a verified sandbox', () => {
    const wants = ctx({ policy: { ...DEFAULT_POLICY, executableWorkRequested: true } });
    expect(evaluate({ kind: 'execute_code' }, wants).outcome).toBe('deny');
  });

  it('always requires approval for sensitive actions, regardless of tier', () => {
    for (const k of ['project_data_deletion', 'external_communication', 'permission_change', 'host_change'] as const) {
      expect(evaluate({ kind: 'sensitive', approvalKind: k }, ctx()).outcome).toBe('requires_approval');
    }
  });
});

describe('paths', () => {
  it('rejects traversal and absolute segments', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hdw-p-'));
    expect(resolveInside(root, 'projects', 'prj_1')).toBe(path.join(root, 'projects', 'prj_1'));
    for (const bad of ['..', '../x', '/etc', 'a/b', '.hidden', '', 'x\u0000y', '..\\..']) {
      expect(() => resolveInside(root, bad), bad).toThrow(PathPolicyError);
    }
  });

  it('rejects symlinked project directories', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hdw-s-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'hdw-o-'));
    mkdirSync(path.join(root, 'projects'), { recursive: true });
    symlinkSync(outside, path.join(root, 'projects', 'prj_evil'));
    expect(() => assertNoSymlinks(root, path.join(root, 'projects', 'prj_evil'))).toThrow(/Symlink/);
    expect(() => ensureProjectDirs(root, 'prj_evil')).toThrow();
    expect(ensureProjectDirs(root, 'prj_ok').input).toBe(path.join(root, 'projects', 'prj_ok', 'input'));
  });
});

describe('uploads', () => {
  const buf = (s: string) => Buffer.from(s, 'utf8');

  it('accepts txt, md and valid json with hashes', () => {
    const v = validateOne('notes.md', buf('# hi'));
    expect(v.mediaType).toBe('text/markdown');
    expect(v.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validateOne('d.json', buf('{"a":1}')).mediaType).toBe('application/json');
  });

  it('rejects unsupported, binary, invalid UTF-8 and archive content', () => {
    expect(() => validateOne('x.pdf', buf('%PDF-1.4'))).toThrow(/Unsupported/);
    expect(() => validateOne('x.txt', Buffer.from([0x68, 0x00, 0x69]))).toThrow(/binary/);
    expect(() => validateOne('x.txt', Buffer.from([0xff, 0xfe, 0xfd]))).toThrow(/UTF-8/);
    expect(() => validateOne('x.txt', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x41]))).toThrow(/zip/);
    expect(() => validateOne('x.json', buf('{bad'))).toThrow(/JSON/);
  });

  it('enforces size and count limits', () => {
    const limits = { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15 };
    expect(() => validateUploads([{ name: 'a.txt', bytes: buf('12345678901') }], limits)).toThrow(/exceeds/);
    expect(() => validateUploads([1, 2, 3].map((i) => ({ name: `${i}.txt`, bytes: buf('x') })), limits)).toThrow(/At most/);
    expect(() => validateUploads([{ name: 'a.txt', bytes: buf('12345678') }, { name: 'b.txt', bytes: buf('12345678') }], limits)).toThrow(/Total/);
  });

  it('sanitizes display names without trusting them as paths', () => {
    expect(sanitizeDisplayName('../../etc/passwd.md')).toBe('passwd.md');
    expect(sanitizeDisplayName('C:\\Users\\me\\brief.txt')).toBe('brief.txt');
    expect(sanitizeDisplayName('a\u0000b\u001f.md')).toBe('ab.md');
    expect(sanitizeDisplayName('')).toBe('untitled.txt');
  });
});
