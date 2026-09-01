/**
 * Fail-closed regular-file presence.
 *
 * `existsSync` collapses permission and I/O errors to `false`, which would let an
 * unreadable `config.toml` or catalog artifact look like a clean absence. Codex
 * startup readiness may skip only a proven ENOENT/ENOTDIR miss with no lexical
 * entry. A dangling symlink is a present unreadable artifact, not absence.
 *
 * Valid symlinks whose followed target is a regular file are treated as a regular
 * file so `atomicWriteFile` and `readCatalog` keep their historical follow/preserve
 * behavior.
 */
export type RegularFileUnreadableReason =
  | "dangling-symlink"
  | "directory"
  | "not-file"
  | "stat-failed";

export type RegularFilePresence =
  | { readonly kind: "absent" }
  | { readonly kind: "regular-file" }
  | { readonly kind: "unreadable"; readonly reason: RegularFileUnreadableReason };

export interface RegularFileLstat {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface RegularFilePresenceIo {
  lstatSync: (path: string) => RegularFileLstat;
  statSync: (path: string) => RegularFileLstat;
}

export function errnoCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

export function isProvenAbsentErrno(code: string): boolean {
  return code === "ENOENT" || code === "ENOTDIR";
}

function classifyFollowedTarget(entry: RegularFileLstat): RegularFilePresence {
  if (entry.isDirectory()) return { kind: "unreadable", reason: "directory" };
  if (!entry.isFile()) return { kind: "unreadable", reason: "not-file" };
  return { kind: "regular-file" };
}

export function classifyRegularFilePresence(
  path: string,
  io: RegularFilePresenceIo,
): RegularFilePresence {
  let entry: RegularFileLstat;
  try {
    entry = io.lstatSync(path);
  } catch (error) {
    return isProvenAbsentErrno(errnoCode(error))
      ? { kind: "absent" }
      : { kind: "unreadable", reason: "stat-failed" };
  }
  if (entry.isSymbolicLink()) {
    let target: RegularFileLstat;
    try {
      target = io.statSync(path);
    } catch (error) {
      return {
        kind: "unreadable",
        reason: isProvenAbsentErrno(errnoCode(error)) ? "dangling-symlink" : "stat-failed",
      };
    }
    return classifyFollowedTarget(target);
  }
  return classifyFollowedTarget(entry);
}
