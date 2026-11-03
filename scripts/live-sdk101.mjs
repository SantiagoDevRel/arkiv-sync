import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectLiveJournal } from './live-journal-path.mjs';
import { ArkivSink, createArkivReader, quoteValue, silentLogger, scrubSecrets } from '../dist/index.js';
import { createPublicClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { custom, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const evidence = { sdk: '1.0.1', transactions: [], queriesKeyA: 0 };
try {
  const journalDirectory = selectLiveJournal();
  const account = privateKeyToAccount(process.env.TEST_SYNC_PRIVATE_KEY);
  assert.equal(account.address.toLowerCase(), process.env.TEST_SYNC_ADDRESS.toLowerCase());
  const accessKey = process.env.ARKIV_ACCESS_KEY_A, chain = rabdi({ accessKey });
  const upstream = http(undefined, { retryCount: 0 })({ chain });
  const transport = custom({ request: async request => {
    if (request.method === 'arkiv_query') evidence.queriesKeyA++;
    const result = await upstream.request(request);
    if (request.method === 'eth_sendRawTransaction' || request.method === 'eth_sendTransaction') {
      evidence.transactions.push({ hash: result });
      fs.mkdirSync('artifacts', { recursive: true });
      fs.writeFileSync('artifacts/live-sdk101.json', JSON.stringify(evidence, null, 2));
    }
    return result;
  } }, { retryCount: 0 });
  const pub = createPublicClient({ chain, transport });
  assert.equal(await pub.getChainId(), 7794095);
  const eventId = 'pkg3b-sdk101-' + Date.now(), sync = eventId;
  const sink = new ArkivSink({ account, accessKey, transport, logger: silentLogger, journalDirectory });
  const record = { eventId, attributes: [{ key: 'sync', value: sync }], data: { purpose: 'SDK compatibility check' }, expiresInSeconds: 3600 };
  const written = await sink.write(record);
  assert.equal(written.op, 'create');
  const reader = createArkivReader({ accessKey, chain, transport });
  assert.equal((await reader.query('event_id = ' + quoteValue(eventId), { owner: account.address })).length, 1);
  assert.equal((await sink.write(record)).op, 'skip');
  await sink.delete(eventId, { sync });
  assert.equal((await reader.query('event_id = ' + quoteValue(eventId), { owner: account.address })).length, 0);
  for (const item of evidence.transactions) {
    const receipt = await pub.getTransactionReceipt({ hash: item.hash }), tx = await pub.getTransaction({ hash: item.hash });
    assert.equal(receipt.status, 'success');
    assert(tx.gas >= 1000000n && tx.gas >= receipt.gasUsed * 2n && tx.gas <= (await pub.getBlock({ blockTag: 'latest' })).gasLimit / 2n);
    Object.assign(item, { status: receipt.status, gas: String(tx.gas), gasUsed: String(receipt.gasUsed), nonce: tx.nonce });
  }
  assert.equal(evidence.transactions.length, 2);
  Object.assign(evidence, { status: 'PASS', owner: account.address, eventId, entityKey: written.key, cleanupConfirmed: true });
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync('artifacts/live-sdk101.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} catch (error) { console.error(scrubSecrets(error)); process.exitCode = 1; }
