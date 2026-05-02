# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js 20+ TypeScript project. Production code lives in `src/`, grouped by domain: `mcp/` for tool handlers, `pipeline/` for mutations, `db/` for SQLite setup, `parser/` and `renderer/` for markdown handling, `sync/` for watcher/normalizer logic, `search/` for FTS/vector search, `extraction/` for embedded-file extraction, and `undo/` for reversible operations. Tests live in `tests/` with matching domain folders such as `tests/mcp/`, `tests/pipeline/`, and `tests/search/`. Fixtures are under `tests/fixtures/`; design notes and plans are in `docs/superpowers/`.

## Build, Test, and Development Commands

- `npm run dev`: run `src/index.ts` with `tsx watch` for local development.
- `npm run build`: compile TypeScript and run the test TypeScript project typecheck.
- `npm start`: run the built stdio server from `dist/index.js`.
- `npm run start:http`: run the built HTTP transport.
- `npm test`: run the Vitest suite, excluding `tests/perf/`.
- `npm run test:perf`: run performance tests with `vitest.perf.config.ts`.

## Coding Style & Naming Conventions

Use TypeScript ESM with strict compiler settings. Keep source filenames lowercase and hyphenated, for example `safe-path.ts` and `query-nodes.ts`. Prefer named exports and keep tool logic under `src/mcp/tools/`. Match the existing two-space indentation, semicolon style, and single-quoted imports. There is no lint script, so rely on `npm run build` and nearby code style before submitting.

## Testing Guidelines

Vitest is the test framework. Name tests `*.test.ts` and place them in the domain folder that matches the behavior under test. Use helpers from `tests/helpers/` and fixtures from `tests/fixtures/`. Add regression tests for pipeline, schema, MCP response, sync, and undo changes because these paths share stateful behavior. Run `npm test` before general changes; run `npm run test:perf` only when search/indexing performance is relevant.

## Commit & Pull Request Guidelines

Recent history uses concise conventional-style subjects such as `test(create-node): close source-attribution invariant gap`, `refactor(watcher): remove default pre-merge`, and `docs(watcher): update processFileChange JSDoc`. Follow `type(scope): summary` when practical, with imperative or descriptive summaries under one line.

Pull requests should describe the behavioral change, list validation commands run, and call out schema, database, file-write, or MCP contract impacts. Link related issues or design docs. Include screenshots only for user-visible HTTP/client changes.

## Security & Configuration Tips

Do not commit vault data, generated `dist/`, local SQLite databases, or API keys. Extraction providers are gated by environment variables such as `DEEPGRAM_API_KEY` and `VISION_PROVIDER`; document new variables in `README.md`. Route all vault filesystem access through existing safe path utilities.
