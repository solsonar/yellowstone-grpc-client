// Minimal pipeline: connect, subscribe, log every event.
//
//   YELLOWSTONE_ENDPOINT=https://your-host:443 \
//   YELLOWSTONE_TOKEN=your-token \
//   node examples/basic-subscribe.js

import {
  YellowstoneClient,
  COMMITMENT_CONFIRMED,
} from '../src/index.js';

const endpoint = process.env.YELLOWSTONE_ENDPOINT;
const token    = process.env.YELLOWSTONE_TOKEN;

if (!endpoint) {
  console.error('Set YELLOWSTONE_ENDPOINT');
  process.exit(1);
}

const client = new YellowstoneClient({ endpoint, token });

client.on('connecting',  ({ target }) => console.log(`[connecting] ${target}`));
client.on('firstData',   ({ latencyMs }) => console.log(`[firstData] +${latencyMs}ms`));
client.on('subscriptionWritten', (s) => console.log(`[subscribed] accounts=${s.accounts} txFilters=${s.txFilters}`));
client.on('ready',       () => console.log('[ready]'));
client.on('account',     (acc) => console.log(`[account] slot=${acc.slot}`));
client.on('transaction', (tx)  => console.log(`[transaction] slot=${tx.slot}`));
client.on('slot',        (s)   => console.log(`[slot] ${s.slot}`));
client.on('reconnect',   (r)   => console.log(`[reconnect] #${r.attempt} in ${r.delayMs}ms (${r.reason})`));
client.on('giveUp',      ()    => { console.error('[giveUp]'); process.exit(1); });
client.on('error',       (err) => console.error('[error]', err.message));
client.on('stale',       (s)   => console.warn(`[stale] silenced for ${s.silenceMs}ms`));

await client.start({
  // Watch a couple of well-known accounts as a smoke test.
  accounts: {
    smoke: { account: ['So11111111111111111111111111111111111111112'] },
  },
  commitment: COMMITMENT_CONFIRMED,
});

process.on('SIGINT', () => {
  console.log('\nshutting down...');
  client.stop();
  process.exit(0);
});
