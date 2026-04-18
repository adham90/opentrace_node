# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-18

### Changed

- **Auto-detect environment**: `environment` now resolves automatically from `OPENTRACE_ENV` → `NODE_ENV` when not set explicitly. Most apps can drop the explicit `environment: 'production'` line from `init()` — `NODE_ENV` carries it. The server pairs this with per-env scoped MCP tokens, so the env string becomes the key to which traffic a given token can see.
- **Flat payload schema**: payloads now use the segmented log store's flat schema — top-level fields replace the previous nested structure.
- **Schema update**: `handler` replaces `controller` + `action`; `error_class` is now a first-class top-level field.

## [0.1.0] - initial

- Structured log forwarding with batching, compression, and circuit breaker.
- Express/Fastify/Koa middleware.
- SQL / HTTP / console capture instrumentation.
- PII scrubbing, sampling, rate limiting.
- 194 tests, ESM + CJS dual-publish.
