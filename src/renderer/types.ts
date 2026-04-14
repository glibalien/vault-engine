// src/renderer/types.ts

export interface RenderInput {
  types: string[];
  fields: Record<string, unknown>;        // field values from DB (reconstructed)
  body: string;
  fieldOrdering: FieldOrderEntry[];        // resolved ordering from merge algorithm
  referenceFields: Set<string>;            // fields whose values need [[wiki-link]] wrapping
  listReferenceFields: Set<string>;        // list fields whose elements need [[wiki-link]] wrapping
  orphanRawValues: Record<string, string>; // field → value_raw_text for orphans with wiki-links
}

export interface FieldOrderEntry {
  field: string;
  category: 'claimed' | 'orphan';
}
