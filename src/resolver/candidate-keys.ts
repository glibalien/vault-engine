import { basename } from 'node:path';

export interface NodeLike {
  file_path: string;
  title: string | null;
}

export interface CandidateKeys {
  file_path: string;
  title: string | null;
  basename: string;
  basenameLower: string;
  basenameNfcLower: string;
}

export function candidateKeysForNode(node: NodeLike): CandidateKeys {
  const base = basename(node.file_path, '.md');
  return {
    file_path: node.file_path,
    title: node.title,
    basename: base,
    basenameLower: base.toLowerCase(),
    basenameNfcLower: base.normalize('NFC').toLowerCase(),
  };
}
