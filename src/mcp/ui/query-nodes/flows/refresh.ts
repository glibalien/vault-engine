/**
 * Refresh flow — re-fetch query-nodes with the current args, update the
 * state envelope, return success/failure for the caller (app.ts) to
 * decide whether to re-render.
 */
import type { Client } from "../client.js";
import type { UiState } from "../types.js";

export async function refresh(state: UiState, client: Client): Promise<void> {
  const env = await client.queryNodes(state.currentArgs);
  state.envelope = env;
}
