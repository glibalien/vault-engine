const writeLocks = new Set<string>();

export function acquireWriteLock(relativePath: string): void {
  writeLocks.add(relativePath);
}

export function releaseWriteLock(relativePath: string): void {
  writeLocks.delete(relativePath);
}

export function isWriteLocked(relativePath: string): boolean {
  return writeLocks.has(relativePath);
}
