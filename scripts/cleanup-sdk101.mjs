import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createPublicClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { custom, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const target = path.resolve(process.argv[2]);
assert(target.startsWith(path.resolve(process.env.TMPDIR) + path.sep), 'Only this job\'s generated consumer can be cleaned');
const { ArkivSink, FileWriteJournal, createArkivReader, quoteValue, silentLogger } = await import(pathToFileURL(path.join(target, 'node_modules/arkiv-sync/dist/index.js')).href);
const account = privateKeyToAccount(process.env.TEST_SYNC_PRIVATE_KEY);
assert.equal(account.address.toLowerCase(), process.env.TEST_SYNC_ADDRESS.toLowerCase());
const accessKey = process.env.ARKIV_ACCESS_KEY_A, chain = rabdi({ accessKey });
const evidence = { sdk: '1.0.1', transactions: [], queriesKeyA: 0 };
const upstream = http(undefined, { retryCount: 0 })({ chain });
const transport = custom({ request: async request => {
  if (request.method === 'arkiv_query') evidence.queriesKeyA++;
  const result = await upstream.request(request);
  if (/^eth_send(Raw)?Transaction$/.test(request.method)) evidence.transactions.push({ kind: 'cleanup', hash: result });
  return result;
} }, { retryCount: 0 });
const pub = createPublicClient({ chain, transport });
const journal = new FileWriteJournal(path.join(target, '.arkiv-sync'));
const sink = new ArkivSink({ account, accessKey, transport, logger: silentLogger, journal });
const reader = createArkivReader({ accessKey, chain, transport });
const entries = (await journal.entries(sink.identity)).filter(e => e.targets.some(t => t.kind === 'upsert'));
assert.equal(entries.length, 1, 'The generated verification must perform one small write');
for (const entry of entries) {
  assert.equal(entry.state, 'confirmed');
  assert.equal(entry.targets.length, 1);
  assert.equal((await pub.getTransactionReceipt({ hash: entry.txHash })).status, 'success');
  evidence.transactions.push({ kind: 'generated-verify', hash: entry.txHash });
  for (const t of entry.targets) {
    assert(t.eventId && t.sync && t.key);
    const predicate = 'event_id = ' + quoteValue(t.eventId) + ' AND sync = ' + quoteValue(t.sync);
    const rows = await reader.query(predicate, { owner: account.address });
    assert.equal(rows.length, 1); assert.equal(rows[0].key, t.key);
    await sink.delete(t.eventId, { sync: t.sync });
    assert.equal((await reader.query(predicate, { owner: account.address })).length, 0);
  }
}
for (const item of evidence.transactions) {
  const receipt = await pub.getTransactionReceipt({ hash: item.hash }), tx = await pub.getTransaction({ hash: item.hash });
  assert.equal(receipt.status, 'success');
  assert(tx.gas >= 1000000n && tx.gas >= receipt.gasUsed * 2n && tx.gas <= (await pub.getBlock({ blockTag: 'latest' })).gasLimit / 2n);
  Object.assign(item, { status: receipt.status, gas: String(tx.gas), gasUsed: String(receipt.gasUsed), nonce: tx.nonce });
}
Object.assign(evidence, { status: 'PASS', generatedTypecheckAndVerify: true, cleanupConfirmed: true, owner: account.address });
const output = fileURLToPath(new URL('../artifacts/scaffold-live-sdk101.json', import.meta.url));
fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
