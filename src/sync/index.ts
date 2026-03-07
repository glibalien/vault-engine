export { indexFile, rebuildIndex, deleteFile, incrementalIndex } from './indexer.js';
export { watchVault, acquireWriteLock, releaseWriteLock, isWriteLocked } from './watcher.js';
export type { WatcherOptions } from './watcher.js';
