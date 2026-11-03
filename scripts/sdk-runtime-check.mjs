import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as sdk from '@arkiv-network/sdk';
import * as entityExports from '@arkiv-network/sdk/entity';
import { defineSchema, str } from '@arkiv-network/sdk/schema';
import { custom, defineChain, encodeErrorResult, parseAbi, toHex } from 'viem';

const version = JSON.parse(fs.readFileSync('node_modules/@arkiv-network/sdk/package.json')).version;
const patched = version === '1.0.1';
const hash = '0x' + 'ab'.repeat(32), key = '0x' + 'cd'.repeat(32);
const address = '0x1111111111111111111111111111111111111111';
const native = '0x4400000000000000000000000000000000000044';
const chain = defineChain({ id: 7794095, name: 'Deterministic SDK check', nativeCurrency: { name: 'GLM', symbol: 'GLM', decimals: 18 }, rpcUrls: { default: { http: ['http://invalid.invalid'] } } });
function fixture({ estimate = 100000n, reverted = false, gasUsed = 10000n, expiryRevert = false } = {}) {
  const sends = [], requests = [];
  const wallet = sdk.createWalletClient({ chain, account: address, transport: custom({ request: async ({ method, params = [] }) => {
    requests.push(method);
    if (method === 'eth_chainId') return toHex(chain.id);
    if (method === 'eth_blockNumber') return '0x64';
    if (method === 'eth_estimateGas') return toHex(estimate);
    if (method === 'eth_sendTransaction') { sends.push(params[0]); return hash; }
    if (method === 'eth_getTransactionByHash') return { hash, from: address, to: native, gas: sends[0].gas, gasPrice: '0x1', value: '0x0', input: sends[0].data, nonce: '0x0', type: '0x0', blockNumber: '0x65', blockHash: key, transactionIndex: '0x0', v: '0x1b', r: '0x1', s: '0x1' };
    if (method === 'eth_getTransactionReceipt') return { transactionHash: hash, transactionIndex: '0x0', blockHash: key, blockNumber: '0x65', from: address, to: native, cumulativeGasUsed: toHex(gasUsed), gasUsed: toHex(gasUsed), effectiveGasPrice: '0x1', status: reverted ? '0x0' : '0x1', type: '0x0', contractAddress: null, logsBloom: '0x' + '0'.repeat(512), logs: [] };
    if (method === 'eth_call') {
      if (expiryRevert) throw Object.assign(new Error('Execution reverted'), { code: 3, data: encodeErrorResult({ abi: parseAbi(['error ExpiryBeyondMaxLifetime(uint64 target,uint64 currentBlock,uint64 maxLifetime)']), errorName: 'ExpiryBeyondMaxLifetime', args: [7884102n, 101n, 7884000n] }) });
      return '0x';
    }
    throw Error('Unexpected deterministic RPC: ' + method);
  } }, { retryCount: 0 }) });
  return { wallet, sends, requests };
}
const gasCases = [];
for (const estimate of [100000n, 15000000n, 20000000n]) {
  const f = fixture({ estimate });
  await f.wallet.deleteEntity({ entityKey: key }, { nonce: 0, gasPrice: 1n });
  const gas = f.sends[0].gas;
  if (patched) assert.equal(BigInt(gas), estimate > 16777216n ? estimate : estimate * 125n / 100n > 16777216n ? 16777216n : estimate * 125n / 100n);
  else assert.equal(gas, undefined, 'legacy JSON-RPC account delegates gas to the wallet');
  gasCases.push({ estimate: String(estimate), sentGas: gas ?? null });
}
const explicit = fixture();
await explicit.wallet.deleteEntity({ entityKey: key }, { nonce: 0, gasPrice: 1n, gas: 3000000n });
assert.equal(BigInt(explicit.sends[0].gas), 3000000n);
const expiry = fixture({ reverted: true, expiryRevert: true });
let expiryError;
try { await expiry.wallet.createEntity(defineSchema('sdk-check', { value: str() }), { value: 'one' }, { expiration: sdk.ExpirationTime.fromBlocks(7884001) }, { nonce: 0, gasPrice: 1n, gas: 1000000n }); } catch (error) { expiryError = error; }
assert(expiryError);
assert.equal(expiry.sends.length, patched ? 0 : 1);
assert.equal(expiryError.name, patched ? 'InvalidExpiryError' : 'EntityMutationError');
assert.match(expiryError.message, /maximum lifetime/);
const exhausted = fixture({ reverted: true, gasUsed: 1000000n });
let gasError;
try { await exhausted.wallet.deleteEntity({ entityKey: key }, { nonce: 0, gasPrice: 1n, gas: 1000000n }); } catch (error) { gasError = error; }
assert.equal(gasError?.name, 'EntityMutationError');
assert.match(gasError.message, patched ? /ran out of gas:/ : /reverted\./);
if (patched) {
  assert.equal(sdk.MAX_LIFETIME, 7884000n);
  assert.equal(entityExports.MAX_LIFETIME, sdk.MAX_LIFETIME);
  assert.equal(sdk.ExpirationTime.max().minLifetime, sdk.MAX_LIFETIME);
}
console.log(JSON.stringify({ status: 'PASS', sdk: version, tests: 7, networkRequests: 0, realBroadcasts: 0, gasCases, explicitGasUnchanged: true, expiry: { name: expiryError.name, sends: expiry.sends.length }, gasExhaustion: { name: gasError.name, message: gasError.message }, maximumExports: patched }));
