import { describe, expect, it } from 'vitest';
import { describeMcpRequestBody } from '../src/transport/http.js';

describe('HTTP MCP request logging', () => {
  it('describes tool calls without including arguments', () => {
    const label = describeMcpRequestBody({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create-node',
        arguments: {
          title: 'Long Note',
          body: 'x'.repeat(10_000),
        },
      },
    });

    expect(label).toBe('MCP tools/call:create-node');
    expect(label).not.toContain('Long Note');
    expect(label).not.toContain('xxxxx');
  });

  it('describes non-tool JSON-RPC calls by method', () => {
    expect(describeMcpRequestBody({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'test-client' },
      },
    })).toBe('MCP initialize');
  });

  it('summarizes JSON-RPC batches with a short bounded label', () => {
    expect(describeMcpRequestBody([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get-node', arguments: { path: 'A.md' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'query-nodes', arguments: { query: 'status=open' } } },
      { jsonrpc: '2.0', id: 3, method: 'notifications/initialized' },
    ])).toBe('MCP batch[MCP tools/call:get-node, MCP tools/call:query-nodes, MCP notifications/initialized]');
  });
});
