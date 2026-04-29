// Smoke tests. The full reconnect / subscription pipeline requires a real
// Yellowstone endpoint and is exercised by the examples; here we only verify
// the public surface.
//
// Run with: node --test test/

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  YellowstoneClient,
  COMMITMENT_PROCESSED,
  COMMITMENT_CONFIRMED,
  COMMITMENT_FINALIZED,
  DEFAULT_STALE_TIMEOUT_MS,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_RECONNECT_BASE_DELAY_MS,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
} from '../src/index.js';

test('exports commitment constants with correct values', () => {
  assert.equal(COMMITMENT_PROCESSED, 0);
  assert.equal(COMMITMENT_CONFIRMED, 1);
  assert.equal(COMMITMENT_FINALIZED, 2);
});

test('exports default timing constants', () => {
  assert.equal(DEFAULT_STALE_TIMEOUT_MS, 60_000);
  assert.equal(DEFAULT_PING_INTERVAL_MS, 10_000);
  assert.equal(DEFAULT_RECONNECT_BASE_DELAY_MS, 3_000);
  assert.equal(DEFAULT_RECONNECT_MAX_DELAY_MS, 60_000);
  assert.equal(DEFAULT_MAX_RECONNECT_ATTEMPTS, 20);
});

test('YellowstoneClient throws when endpoint is missing', () => {
  assert.throws(() => new YellowstoneClient({}), /endpoint/);
  assert.throws(() => new YellowstoneClient(), /endpoint/);
});

test('YellowstoneClient applies option defaults', () => {
  const c = new YellowstoneClient({ endpoint: 'https://x:443' });
  assert.equal(c._staleTimeoutMs,       DEFAULT_STALE_TIMEOUT_MS);
  assert.equal(c._pingIntervalMs,       DEFAULT_PING_INTERVAL_MS);
  assert.equal(c._maxReconnectAttempts, DEFAULT_MAX_RECONNECT_ATTEMPTS);
});

test('YellowstoneClient honours overrides', () => {
  const c = new YellowstoneClient({
    endpoint: 'https://x:443',
    staleTimeoutMs: 30_000,
    pingIntervalMs: 5_000,
    maxReconnectAttempts: 5,
  });
  assert.equal(c._staleTimeoutMs, 30_000);
  assert.equal(c._pingIntervalMs, 5_000);
  assert.equal(c._maxReconnectAttempts, 5);
});

test('YellowstoneClient.isReady() is false before start()', () => {
  const c = new YellowstoneClient({ endpoint: 'https://x:443' });
  assert.equal(c.isReady(), false);
  assert.equal(c.reconnectAttempts(), 0);
});

test('YellowstoneClient.stop() is idempotent and safe before start()', () => {
  const c = new YellowstoneClient({ endpoint: 'https://x:443' });
  c.stop();  // no error
  c.stop();  // no error
});
