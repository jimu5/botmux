/**
 * Working-directory path helpers, kept dependency-light so the CLI entrypoint
 * can import them without dragging in the daemon graph (worker-pool, PTY, …).
 */
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { t, type Locale } from '../i18n/index.js';

export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/**
 * Validate a user-supplied path for `/cd` and `/oncall bind`. Trust model is
 * "owner explicitly chose a directory" — the daemon already runs CLI prompts
 * with full filesystem access, so an allowlist would be theater. We only do
 * the typo guards: exists and is a directory.
 */
export function validateWorkingDir(input: string, locale?: Locale): { ok: true; resolvedPath: string } | { ok: false; error: string } {
  const resolvedPath = resolve(expandHome(input));
  if (!existsSync(resolvedPath)) {
    return { ok: false, error: t('cmd.cd.dir_not_exist', { path: resolvedPath }, locale) };
  }
  let isDir = false;
  try { isDir = statSync(resolvedPath).isDirectory(); } catch (e: any) {
    return { ok: false, error: t('cmd.cd.cannot_read', { path: resolvedPath, msg: e?.message ?? String(e) }, locale) };
  }
  if (!isDir) {
    return { ok: false, error: t('cmd.cd.not_a_directory', { path: resolvedPath }, locale) };
  }
  return { ok: true, resolvedPath };
}
