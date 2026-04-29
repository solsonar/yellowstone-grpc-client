# @solsonar/yellowstone-grpc-client

Production-ready Yellowstone (Geyser) gRPC client for Solana. TLS + `x-token` auth, heartbeat pings, stale detection, exponential-backoff reconnect, live subscription updates.

```js
import {
  YellowstoneClient,
  COMMITMENT_CONFIRMED,
} from '@solsonar/yellowstone-grpc-client';

const client = new YellowstoneClient({
  endpoint: 'https://yellowstone.example.com:443',
  token: process.env.YELLOWSTONE_TOKEN,
});

client.on('account',     (acc) => { /* account update */ });
client.on('transaction', (tx)  => { /* tx update */ });
client.on('error',       (err) => console.error(err));

await client.start({
  accounts: {
    myPools: { account: ['Pool1...', 'Pool2...'] },
  },
  transactions: {
    swaps: { accountInclude: ['Pool1...', 'Pool2...'] },
  },
  commitment: COMMITMENT_CONFIRMED,
});
```

## What this package gives you

The official `@triton-one/yellowstone-grpc` SDK provides the protobuf types and a low-level streaming RPC, but you have to wire health checks, reconnection, and subscription management yourself. This package is that wiring, hardened in production:

- **TLS + `x-token` auth** — works with Triton, Helius, and self-hosted relays.
- **Heartbeat pings** every 10 s, sent as actual `SubscribeRequestPing` messages (the only thing that keeps long-running streams alive).
- **Stale detection** — if no `'data'` event arrives for 60 s, the stream is considered dead and recreated. Without this, your bot silently goes deaf.
- **Exponential backoff reconnect** — 3 s → 60 s, capped, max 20 attempts before `'giveUp'`. Reconnect attempts re-issue the last subscription automatically.
- **Live subscription updates** — `updateSubscription()` mutates filters mid-stream without dropping data. Yellowstone supports this; most wrappers do not.
- **Event-driven** — no `console.log` inside the library. Bind handlers where you want them.

## What this package does not do

- It does not parse account data (you get the raw `Buffer`, decode it yourself with `BorshAccountsCoder` or your decoder of choice).
- It does not deserialize transactions — you get the `CompiledTransaction` from the proto, run `VersionedTransaction.deserialize` yourself.
- It does not resolve Address Lookup Tables. Pair with [`@solsonar/solana-alt-cache`](https://www.npmjs.com/package/@solsonar/solana-alt-cache) for that.

## Install

```sh
npm install @solsonar/yellowstone-grpc-client \
            @grpc/grpc-js \
            @triton-one/yellowstone-grpc
```

The two gRPC packages are peer dependencies. `@triton-one/yellowstone-grpc` is pinned to **1.4.0** because v5+ moved the `dist/grpc/geyser` subpath and the project deliberately uses the lower-level `GeyserClient` (not the NAPI `Client` wrapper) for production performance. Newer versions can be supported by matching the new path; open an issue.

Requires Node 18+.

## API

### `new YellowstoneClient(options)`

| option                   | type    | default | notes                                            |
| ------------------------ | ------- | ------- | ------------------------------------------------ |
| `endpoint`               | string  | —       | Required. Full URL, e.g. `https://host:443`      |
| `token`                  | string  | —       | Optional. Sent as `x-token` metadata             |
| `staleTimeoutMs`         | number  | `60_000` | Reconnect after this much silence                |
| `staleCheckIntervalMs`   | number  | `15_000` | Health check cadence                             |
| `pingIntervalMs`         | number  | `10_000` | Heartbeat cadence                                |
| `reconnectBaseDelayMs`   | number  | `3_000`  | First reconnect delay (doubled each attempt)     |
| `reconnectMaxDelayMs`    | number  | `60_000` | Reconnect delay ceiling                          |
| `maxReconnectAttempts`   | number  | `20`     | Give up after this many consecutive failures      |

### Methods

- `start(subscriptionPlain)` — open the stream and write the initial subscription.
- `updateSubscription(subscriptionPlain)` — replace filters mid-stream.
- `stop()` — close the stream and clear timers. Idempotent.
- `isReady()` — `true` if the stream is open and not currently reconnecting.
- `reconnectAttempts()` — count since last successful connect.

### Subscription shape

```ts
{
  accounts?: {
    [name]: {
      account?: string[],   // pubkeys
      owner?: string[],     // programs
      filters?: object[],   // memcmp / dataSize (yellowstone proto)
    }
  },
  transactions?: {
    [name]: {
      accountInclude?: string[],
      accountExclude?: string[],
      accountRequired?: string[],
      vote?: boolean,    // default false
      failed?: boolean,  // default false
    }
  },
  commitment?: 0 | 1 | 2,  // PROCESSED | CONFIRMED | FINALIZED, default CONFIRMED
}
```

### Events

| event                 | payload                                           |
| --------------------- | ------------------------------------------------- |
| `'connecting'`        | `{ target: string }` — about to dial                |
| `'firstData'`         | `{ latencyMs: number }` — first message arrived   |
| `'subscriptionWritten'` | `{ accounts: number, txFilters: number }`         |
| `'ready'`             | `()` — subscription written, healthy             |
| `'account'`           | proto `SubscribeUpdateAccount`                    |
| `'transaction'`       | proto `SubscribeUpdateTransaction`                |
| `'slot'`              | proto `SubscribeUpdateSlot`                       |
| `'message'`           | any other oneof message (advanced)                |
| `'status'`            | `{ code, details }` — gRPC status                 |
| `'stale'`             | `{ silenceMs: number }` — stale detected          |
| `'reconnect'`         | `{ attempt, delayMs, reason }` — about to retry   |
| `'end'`               | `()` — stream ended cleanly                       |
| `'close'`             | `()` — stream closed                              |
| `'error'`             | `(err: Error)`                                    |
| `'giveUp'`            | `()` — exceeded `maxReconnectAttempts`            |

### Constants

```js
import {
  COMMITMENT_PROCESSED,                // 0
  COMMITMENT_CONFIRMED,                // 1
  COMMITMENT_FINALIZED,                // 2
  DEFAULT_STALE_TIMEOUT_MS,            // 60_000
  DEFAULT_PING_INTERVAL_MS,            // 10_000
  DEFAULT_RECONNECT_BASE_DELAY_MS,     // 3_000
  DEFAULT_RECONNECT_MAX_DELAY_MS,      // 60_000
  DEFAULT_MAX_RECONNECT_ATTEMPTS,      // 20
} from '@solsonar/yellowstone-grpc-client';
```

## Examples

See [`examples/`](./examples) for runnable scripts:

- `basic-subscribe.js` — minimal pipeline, prints any update.
- `account-watcher.js` — watch a list of accounts, decode amounts.
- `transaction-watcher.js` — print txs touching given programs.

## Why pin `@triton-one/yellowstone-grpc` to 1.4.0?

Newer versions of `@triton-one/yellowstone-grpc` removed the `dist/grpc/geyser` subpath and re-bundled the Geyser client behind a NAPI wrapper. The wrapper makes it harder to control the underlying gRPC channel — connection pooling, custom credentials, and per-message backpressure are all easier on the lower-level `GeyserClient` from 1.4.0. Production producers (e.g. Triton's own `sol-tracker-producer`) use the same setup. If you need a newer version, open an issue.

## License

MIT
# yellowstone-grpc-client
