// SPDX-License-Identifier: MIT

import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

const grpc = require('@grpc/grpc-js');
const {
  GeyserClient,
  SubscribeRequest,
  SubscribeRequestFilterAccounts,
  SubscribeRequestFilterTransactions,
  SubscribeRequestPing,
} = require('@triton-one/yellowstone-grpc/dist/grpc/geyser');

// ─── Defaults ───────────────────────────────────────────────────────────────

/** Reconnect after this much silence (no `'data'` event) — default 60s. */
export const DEFAULT_STALE_TIMEOUT_MS = 60_000;
/** How often the health timer runs — default 15s. */
export const DEFAULT_STALE_CHECK_INTERVAL_MS = 15_000;
/** Heartbeat ping cadence — default 10s. */
export const DEFAULT_PING_INTERVAL_MS = 10_000;
/** First reconnect delay (doubled each attempt). */
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 3_000;
/** Reconnect delay ceiling. */
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 60_000;
/** Give up after this many consecutive failures. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 20;

// ─── CommitmentLevel constants (from Yellowstone proto) ─────────────────────

/** PROCESSED — fastest, may be rolled back. */
export const COMMITMENT_PROCESSED = 0;
/** CONFIRMED — recommended for most workloads. */
export const COMMITMENT_CONFIRMED = 1;
/** FINALIZED — strongest guarantee, slowest. */
export const COMMITMENT_FINALIZED = 2;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Strip protocol/path from a URL and return `host:port`. The Yellowstone gRPC
 * client takes a bare authority string.
 *
 * @param {string} endpointUrl  e.g. `"https://yellowstone.example.com:443"`
 * @returns {string}            e.g. `"yellowstone.example.com:443"`
 */
function buildGrpcEndpoint(endpointUrl) {
  const url = new URL(endpointUrl);
  return `${url.hostname}:${url.port || 443}`;
}

/**
 * Build TLS credentials. If a token is provided, attach it as `x-token`
 * metadata on every call. This matches the Triton/Helius Yellowstone auth
 * scheme.
 *
 * @private
 */
function buildCreds(token) {
  const ssl = grpc.credentials.createSsl();
  if (!token) return ssl;
  return grpc.credentials.combineChannelCredentials(
    ssl,
    grpc.credentials.createFromMetadataGenerator((_params, cb) => {
      const md = new grpc.Metadata();
      md.add('x-token', token);
      cb(null, md);
    }),
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} YellowstoneClientOptions
 * @property {string}  endpoint                   Yellowstone gRPC endpoint URL (e.g. `https://your-host:443`).
 * @property {string}  [token]                    Optional auth token sent as `x-token` metadata.
 * @property {number}  [staleTimeoutMs]           Reconnect after this much silence. Default {@link DEFAULT_STALE_TIMEOUT_MS}.
 * @property {number}  [staleCheckIntervalMs]     Health check cadence. Default {@link DEFAULT_STALE_CHECK_INTERVAL_MS}.
 * @property {number}  [pingIntervalMs]           Heartbeat cadence. Default {@link DEFAULT_PING_INTERVAL_MS}.
 * @property {number}  [reconnectBaseDelayMs]     First reconnect delay (doubled each attempt). Default {@link DEFAULT_RECONNECT_BASE_DELAY_MS}.
 * @property {number}  [reconnectMaxDelayMs]      Reconnect delay ceiling. Default {@link DEFAULT_RECONNECT_MAX_DELAY_MS}.
 * @property {number}  [maxReconnectAttempts]     Give up after this many failures. Default {@link DEFAULT_MAX_RECONNECT_ATTEMPTS}.
 */

/**
 * @typedef {object} SubscriptionPlain
 * @property {Record<string, AccountFilter>}     [accounts]      Named account filters.
 * @property {Record<string, TransactionFilter>} [transactions]  Named transaction filters.
 * @property {0|1|2}                             [commitment]    See COMMITMENT_* constants. Default CONFIRMED.
 *
 * @typedef {object} AccountFilter
 * @property {string[]} [account]   Specific account pubkeys to watch.
 * @property {string[]} [owner]     Watch any account owned by these programs.
 * @property {object[]} [filters]   memcmp / dataSize filters (see Yellowstone proto).
 *
 * @typedef {object} TransactionFilter
 * @property {string[]} [accountInclude]   Match if tx touches any of these accounts.
 * @property {string[]} [accountExclude]   Skip if tx touches any of these.
 * @property {string[]} [accountRequired]  Must touch all of these.
 * @property {boolean}  [vote]             Include vote tx? Default false.
 * @property {boolean}  [failed]           Include failed tx? Default false.
 */

// ─── YellowstoneClient ──────────────────────────────────────────────────────

/**
 * Production-ready Yellowstone (Geyser) gRPC client.
 *
 * - TLS with optional `x-token` auth (Triton, Helius, your own relay).
 * - Heartbeat pings every 10 s.
 * - Stale detection: reconnect if no `'data'` event for 60 s.
 * - Exponential backoff reconnect (3s → 60s, capped, max 20 attempts).
 * - Live subscription updates via {@link YellowstoneClient#updateSubscription}.
 *
 * Underneath it uses the raw `GeyserClient` from `@triton-one/yellowstone-grpc`
 * (not the NAPI `Client` wrapper), which is what production-grade producers use.
 *
 * @example
 *   import {
 *     YellowstoneClient,
 *     COMMITMENT_CONFIRMED,
 *   } from '@solsonar/yellowstone-grpc-client';
 *
 *   const client = new YellowstoneClient({
 *     endpoint: 'https://yellowstone.example.com:443',
 *     token: process.env.YELLOWSTONE_TOKEN,
 *   });
 *
 *   client.on('ready',       () => console.log('subscribed'));
 *   client.on('account',     (acc) => { ... });
 *   client.on('transaction', (tx)  => { ... });
 *   client.on('error',       (err) => { ... });
 *   client.on('reconnect',   ({ attempt, delayMs, reason }) => { ... });
 *   client.on('giveUp',      () => { ... });
 *
 *   await client.start({
 *     accounts: {
 *       myPools: { account: ['Pool1...', 'Pool2...'] },
 *     },
 *     transactions: {
 *       swaps: { accountInclude: ['Pool1...', 'Pool2...'] },
 *     },
 *     commitment: COMMITMENT_CONFIRMED,
 *   });
 *
 * @fires YellowstoneClient#ready       `()` — subscription written, stream healthy.
 * @fires YellowstoneClient#account     `(update)` — account changed.
 * @fires YellowstoneClient#transaction `(update)` — matching tx received.
 * @fires YellowstoneClient#slot        `(update)` — slot update (if subscribed).
 * @fires YellowstoneClient#error       `(err: Error)` — stream error.
 * @fires YellowstoneClient#reconnect   `({ attempt, delayMs, reason })` — about to reconnect.
 * @fires YellowstoneClient#giveUp      `()` — exceeded `maxReconnectAttempts`.
 * @fires YellowstoneClient#connecting  `({ target })` — opening the gRPC channel.
 * @fires YellowstoneClient#firstData   `({ latencyMs })` — first message after connect.
 * @fires YellowstoneClient#status      `({ code, details })` — gRPC status from the stream.
 */
export class YellowstoneClient extends EventEmitter {
  /** @param {YellowstoneClientOptions} options */
  constructor(options) {
    super();
    if (!options || typeof options.endpoint !== 'string') {
      throw new TypeError('YellowstoneClient: `endpoint` is required');
    }
    this.endpoint = options.endpoint;
    this.token = options.token;

    this._staleTimeoutMs       = options.staleTimeoutMs       ?? DEFAULT_STALE_TIMEOUT_MS;
    this._staleCheckIntervalMs = options.staleCheckIntervalMs ?? DEFAULT_STALE_CHECK_INTERVAL_MS;
    this._pingIntervalMs       = options.pingIntervalMs       ?? DEFAULT_PING_INTERVAL_MS;
    this._reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this._reconnectMaxDelayMs  = options.reconnectMaxDelayMs  ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    this._maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;

    /** @private */ this._client = null;
    /** @private */ this._stream = null;
    /** @private */ this._isRunning = false;
    /** @private */ this._isReconnecting = false;
    /** @private */ this._reconnectAttempts = 0;
    /** @private */ this._lastDataTimestamp = 0;
    /** @private */ this._staleCheckTimer = null;
    /** @private */ this._pingTimer = null;
    /** @private */ this._currentSubscriptionPlain = null;
    /** @private */ this._streamStartedAt = 0;
    /** @private */ this._streamFirstData = null;
    /** @private */ this._msgCount = 0;
  }

  /**
   * Open the gRPC channel and write the initial subscription. Resolves once the
   * stream is created — actual data arrival is reported via the `'ready'` and
   * `'firstData'` events.
   *
   * @param {SubscriptionPlain} subscriptionPlain
   */
  async start(subscriptionPlain) {
    if (this._isRunning) return;
    this._currentSubscriptionPlain = subscriptionPlain;
    await this._connect();
  }

  /**
   * Replace the active subscription. Yellowstone supports updating filters
   * mid-stream — no reconnect required.
   *
   * @param {SubscriptionPlain} subscriptionPlain
   */
  async updateSubscription(subscriptionPlain) {
    this._currentSubscriptionPlain = subscriptionPlain;
    if (this._stream && this._isRunning) this._sendSubscription();
  }

  /** Close the stream, clear timers, stop reconnecting. Idempotent. */
  stop() {
    this._isRunning = false;
    if (this._staleCheckTimer) { clearInterval(this._staleCheckTimer); this._staleCheckTimer = null; }
    if (this._pingTimer)       { clearInterval(this._pingTimer);       this._pingTimer = null; }
    if (this._stream) {
      try { this._stream.cancel(); } catch { /* already cancelled */ }
      this._stream = null;
    }
    if (this._client) {
      try { this._client.close(); } catch { /* already closed */ }
      this._client = null;
    }
  }

  /** @returns {boolean} True if the stream is open and not currently reconnecting. */
  isReady() { return this._isRunning && !this._isReconnecting; }

  /** @returns {number} Reconnect attempts since last successful connect. */
  reconnectAttempts() { return this._reconnectAttempts; }

  // ─── Internals ────────────────────────────────────────────────────────────

  async _connect() {
    const target = buildGrpcEndpoint(this.endpoint);
    this.emit('connecting', { target });

    this._client = new GeyserClient(target, buildCreds(this.token));

    this._streamStartedAt = Date.now();
    this._streamFirstData = null;
    this._msgCount = 0;
    this._stream = this._client.subscribe();

    this._stream.on('data', (data) => {
      if (!this._streamFirstData) {
        this._streamFirstData = Date.now();
        this.emit('firstData', { latencyMs: this._streamFirstData - this._streamStartedAt });
      }
      this._handleData(data);
    });
    this._stream.on('error', (err) => this._handleError(err));
    this._stream.on('end', () => this._handleEnd());
    this._stream.on('close', () => this.emit('close'));
    this._stream.on('status', (status) => {
      this.emit('status', { code: status?.code, details: status?.details });
    });

    this._sendSubscription();

    this._isRunning = true;
    this._lastDataTimestamp = Date.now();
    this._reconnectAttempts = 0;
    this._isReconnecting = false;

    if (!this._staleCheckTimer) {
      this._staleCheckTimer = setInterval(() => this._checkHealth(), this._staleCheckIntervalMs);
    }
    if (!this._pingTimer) {
      this._pingTimer = setInterval(() => this._sendPing(), this._pingIntervalMs);
    }

    this.emit('ready');
  }

  /**
   * Build a SubscribeRequest using protobuf `.create()` helpers — this is the
   * shape Yellowstone producers expect.
   *
   * @private
   */
  _buildSubscribeRequest(plain) {
    const accountsObj = {};
    for (const [k, v] of Object.entries(plain.accounts ?? {})) {
      accountsObj[k] = SubscribeRequestFilterAccounts.create({
        account: v.account ?? [],
        owner: v.owner ?? [],
        filters: v.filters ?? [],
      });
    }
    const transactionsObj = {};
    for (const [k, v] of Object.entries(plain.transactions ?? {})) {
      transactionsObj[k] = SubscribeRequestFilterTransactions.create({
        accountInclude: v.accountInclude ?? [],
        accountExclude: v.accountExclude ?? [],
        accountRequired: v.accountRequired ?? [],
        vote: v.vote ?? false,
        failed: v.failed ?? false,
      });
    }
    return SubscribeRequest.create({
      slots: {},
      accounts: accountsObj,
      transactions: transactionsObj,
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: plain.commitment ?? COMMITMENT_CONFIRMED,
    });
  }

  _sendSubscription() {
    if (!this._stream || !this._currentSubscriptionPlain) return;
    const req = this._buildSubscribeRequest(this._currentSubscriptionPlain);
    this._stream.write(req);
    const numAccounts = Object.values(this._currentSubscriptionPlain.accounts ?? {})
      .reduce((s, v) => s + (v.account?.length ?? 0), 0);
    const numTxFilters = Object.keys(this._currentSubscriptionPlain.transactions ?? {}).length;
    this.emit('subscriptionWritten', { accounts: numAccounts, txFilters: numTxFilters });
  }

  _handleData(data) {
    this._lastDataTimestamp = Date.now();
    this._msgCount++;

    // Pong is set as oneof — check id presence.
    if (data.pong && data.pong.id !== undefined) return;

    if (data.account && data.account.account && data.account.account.pubkey?.length > 0) {
      this.emit('account', data.account);
      return;
    }
    if (data.transaction && data.transaction.transaction) {
      this.emit('transaction', data.transaction);
      return;
    }
    if (data.slot && data.slot.slot !== undefined) {
      this.emit('slot', data.slot);
      return;
    }
    // Other oneofs (blockMeta, entry, ping, filters-only) are ignored — emit
    // 'message' for advanced users who want everything.
    this.emit('message', data);
  }

  _handleError(err) {
    this.emit('error', err);
    this._scheduleReconnect('stream error');
  }

  _handleEnd() {
    this.emit('end');
    this._scheduleReconnect('stream ended');
  }

  _checkHealth() {
    if (!this._isRunning || this._isReconnecting) return;
    const elapsed = Date.now() - this._lastDataTimestamp;
    if (elapsed > this._staleTimeoutMs) {
      this.emit('stale', { silenceMs: elapsed });
      this._scheduleReconnect('stale stream');
    }
  }

  _sendPing() {
    if (!this._stream || !this._isRunning || this._isReconnecting) return;
    try {
      const pingId = Date.now() % 2_000_000_000;
      this._stream.write(
        SubscribeRequest.create({ ping: SubscribeRequestPing.create({ id: pingId }) }),
        (err) => {
          if (err) {
            this.emit('error', new Error(`ping write failed: ${err.message}`));
            this._scheduleReconnect('ping failed');
          }
        },
      );
    } catch (e) {
      this.emit('error', new Error(`ping throw: ${e.message}`));
      this._scheduleReconnect('ping threw');
    }
  }

  _scheduleReconnect(reason) {
    if (this._isReconnecting) return;
    this._isReconnecting = true;
    this._isRunning = false;

    if (this._stream) {
      try { this._stream.cancel(); } catch { /* already cancelled */ }
      this._stream = null;
    }
    if (this._client) {
      try { this._client.close(); } catch { /* already closed */ }
      this._client = null;
    }

    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.emit('giveUp');
      return;
    }

    const delayMs = Math.min(
      this._reconnectBaseDelayMs * Math.pow(2, this._reconnectAttempts),
      this._reconnectMaxDelayMs,
    );
    this._reconnectAttempts++;
    this.emit('reconnect', { attempt: this._reconnectAttempts, delayMs, reason });

    setTimeout(async () => {
      try {
        await this._connect();
      } catch (e) {
        this.emit('error', e);
        this._isReconnecting = false;
        this._scheduleReconnect('reconnect failed');
      }
    }, delayMs);
  }
}
