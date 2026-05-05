/**
 * Typed wrappers around app.callServerTool with envelope unwrap.
 * Single chokepoint for tool calls — render/flows never call the SDK directly.
 *
 * In M1 only queryNodes / describeSchema / describeGlobalField / listFieldValues
 * are wired. updateNode / renameNode / getNode arrive in M3 and M4.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Envelope, QueryArgs, QueryNodesData, Schema } from "./types.js";

export function unwrapEnvelope<T = unknown>(result: CallToolResult): Envelope<T> {
  const text = (result.content?.[0] as { type: string; text?: string } | undefined)?.text;
  if (typeof text !== "string") {
    throw new Error("Tool result missing text content");
  }
  return JSON.parse(text) as Envelope<T>;
}

type CallFn = App["callServerTool"];

export interface Client {
  queryNodes(args: QueryArgs): Promise<Envelope<QueryNodesData>>;
  describeSchema(name: string): Promise<Envelope<Schema>>;
  describeGlobalField(name: string): Promise<Envelope<Record<string, unknown>>>;
  listFieldValues(field: string): Promise<Envelope<{ values: string[] }>>;
}

export function makeClient(callServerTool: CallFn): Client {
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<Envelope<T>> => {
    const result = await callServerTool({ name, arguments: args });
    return unwrapEnvelope<T>(result);
  };

  return {
    queryNodes: (args) => call<QueryNodesData>("query-nodes", args as Record<string, unknown>),
    describeSchema: (name) => call<Schema>("describe-schema", { name }),
    describeGlobalField: (name) => call<Record<string, unknown>>("describe-global-field", { name }),
    listFieldValues: (field) => call<{ values: string[] }>("list-field-values", { field }),
  };
}
