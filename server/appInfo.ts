import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface AppInfo {
  name: string;
  version: string;
  commit: string | null;
  commit_source: 'env' | 'git' | null;
  /** uncommitted changes in the working tree at server start (null = unknown, e.g. no git) */
  worktree_dirty: boolean | null;
  node: string;
  platform: string;
}

function gitCommit(root: string): string | null {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.slice(4).trim();
    const loose = path.join(root, '.git', ...ref.split('/'));
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
    const packed = fs.readFileSync(path.join(root, '.git', 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.split(' ')[0] : null;
  } catch {
    return null;
  }
}

function gitDirty(root: string): boolean | null {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim().length > 0;
  } catch {
    return null;
  }
}

export function readAppInfo(root: string, env: Record<string, string | undefined> = process.env): AppInfo {
  let version = '0.0.0';
  let name = 'opora-dss';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string; name?: string };
    version = pkg.version ?? version;
    name = pkg.name ?? name;
  } catch {
    /* keep defaults */
  }
  const envCommit = env.APP_COMMIT?.trim();
  const commit = envCommit || gitCommit(root);
  return {
    name,
    version,
    commit: commit || null,
    commit_source: envCommit ? 'env' : commit ? 'git' : null,
    worktree_dirty: envCommit ? null : gitDirty(root),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}
