// Stream every transaction that touches one of the given program IDs.
//
//   YELLOWSTONE_ENDPOINT=https://your-host:443 \
//   YELLOWSTONE_TOKEN=your-token \
//   node examples/transaction-watcher.js <programId> [programId...]
//
// Common program IDs:
//   JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4   Jupiter v6
//   whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc   Orca Whirlpool
//   LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo   Meteora DLMM

import { YellowstoneClient, COMMITMENT_CONFIRMED } from '../src/index.js';

const endpoint = process.env.YELLOWSTONE_ENDPOINT;
const token    = process.env.YELLOWSTONE_TOKEN;
const programs = process.argv.slice(2);

if (!endpoint || programs.length === 0) {
  console.error('Usage: YELLOWSTONE_ENDPOINT=... node examples/transaction-watcher.js <programId> [programId...]');
  process.exit(1);
}

const client = new YellowstoneClient({ endpoint, token });
let count = 0;

client.on('error', (e) => console.error('[error]', e.message));
client.on('transaction', (tx) => {
  count++;
  const sig = tx.transaction?.signature;
  const slot = Number(tx.slot ?? 0n);
  const sigStr = sig ? Buffer.from(sig).toString('hex').slice(0, 16) : '?';
  console.log(`#${count} slot=${slot} sig=${sigStr}`);
});

await client.start({
  transactions: {
    matching: { accountInclude: programs, vote: false, failed: false },
  },
  commitment: COMMITMENT_CONFIRMED,
});

console.log(`watching ${programs.length} program(s) — Ctrl-C to stop`);
process.on('SIGINT', () => { client.stop(); process.exit(0); });
