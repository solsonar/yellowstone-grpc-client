# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

Initial release.

### Added

- `YellowstoneClient` — TLS + `x-token` Yellowstone (Geyser) gRPC client.
- Heartbeat pings, stale detection, exponential backoff reconnect.
- Live subscription updates via `updateSubscription()`.
- Event-driven API (no `console.log` inside the library).
- Examples: `basic-subscribe`, `account-watcher`, `transaction-watcher`.
