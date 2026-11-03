import assert from 'node:assert/strict'
import { Fixture, record } from './sdk08.js'

// Use real SDK encoding, receipt handling and error types. Only the RPC is deterministic.
const f = new Fixture(), original = f.request.bind(f)
let firstHash = '', sentGas = 0n
f.request = async (method, params) => {
  const list = params as any[]
  if (method === 'eth_getTransactionCount') return '0x' + f.sends.toString(16)
  if (method === 'eth_sendTransaction') {
    sentGas = BigInt(list[0].gas)
    const result = await original(method, params)
    if (f.sends === 1) {
      firstHash = result as string
      f.rows.clear() // A reverted transaction applies no effects.
      const receipt = f.receipts.get(firstHash as `0x${string}`) as any
      receipt.status = '0x0'; receipt.gasUsed = list[0].gas; receipt.logs = []
    }
    return result
  }
  if (method === 'eth_getTransactionByHash') return {
    hash: list[0], from: '0x1111111111111111111111111111111111111111',
    to: '0x4400000000000000000000000000000000000044', gas: '0x' + sentGas.toString(16),
    nonce: '0x0', gasPrice: '0x1', value: '0x0', input: '0x', type: '0x0',
    blockHash: '0x' + '33'.repeat(32), blockNumber: '0x64', transactionIndex: '0x0', v: '0x1b', r: '0x1', s: '0x1',
  }
  if (method === 'eth_call') return '0x' // Legacy SDK re-simulation succeeds after OOG.
  return original(method, params)
}
const result = await f.sink().write(record('sdk-gas-regression'))
assert.equal(result.op, 'create')
assert.equal(f.sends, 2)
const sends = f.requests.filter(r => r.method === 'eth_sendTransaction').map(r => (r.params as any[])[0])
assert.equal(BigInt(sends[1].gas), BigInt(sends[0].gas) * 2n)
assert.notEqual(result.txHash, firstHash)
console.log(JSON.stringify({ status: 'PASS', sdk: process.env.SDK_TEST_VERSION ?? '1.0.1', actualSdkGasExhaustion: true, sends: f.sends, gas: sends.map(t => t.gas) }))
