/**
 * Refresh flow — re-fetch query-nodes with the current args, update the
 * state envelope, return success/failure for the caller (app.ts) to
 * decide whether to re-render.
 *
 * Augments args with include_fields: ["*"] so the table can render field
 * values inline. query-nodes omits the per-row `fields` map otherwise.
 */
import type { Client } from "../client.js";
import type { QueryArgs, UiState } from "../types.js";

export async function refresh(state: UiState, client: Client): Promise<void> {
  // Force include_fields: ["*"] — the schema-driven table needs every field
  // value inline regardless of what the caller passed. Override (don't merge).
  const args: QueryArgs = { ...state.currentArgs, include_fields: ["*"] };
  const env = await client.queryNodes(args);
  state.envelope = env;
}
