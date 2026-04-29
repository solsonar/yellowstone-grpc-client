// Watch a list of accounts and log every update with size and slot.
//
//   YELLOWSTONE_ENDPOINT=https://your-host:443 \
//   YELLOWSTONE_TOKEN=your-token \
//   node examples/account-watcher.js <pubkey> [pubkey...]

import { YellowstoneClient, COMMITMENT_CONFIRMED } from '../src/index.js';

const endpoint = process.env.YELLOWSTONE_ENDPOINT;
const token    = process.env.YELLOWSTONE_TOKEN;
const accounts = process.argv.slice(2);

if (!endpoint || accounts.length === 0) {
  console.error('Usage: YELLOWSTONE_ENDPOINT=... node examples/account-watcher.js <pubkey> [pubkey...]');
  process.exit(1);
}

const client = new YellowstoneClient({ endpoint, token });

client.on('error', (e) => console.error('[error]', e.message));
client.on('reconnect', (r) => console.warn(`[reconnect] #${r.attempt} in ${r.delayMs}ms (${r.reason})`));

client.on('account', (update) => {
  const inner = update.account;
  if (!inner) return;
  const pubkey = Buffer.from(inner.pubkey).toString('base64');
  const size = inner.data?.length ?? 0;
  const slot = Number(update.slot ?? 0n);
  console.log(`slot=${slot} pubkey=${pubkey.slice(0, 12)}... size=${size}`);
});

await client.start({
  accounts: { watched: { account: accounts } },
  commitment: COMMITMENT_CONFIRMED,
});

console.log(`watching ${accounts.length} account(s) — Ctrl-C to stop`);
process.on('SIGINT', () => { client.stop(); process.exit(0); });
