import assert from 'node:assert/strict'
import { EntityMutationError } from '@arkiv-network/sdk'
import type { Hex } from 'viem'
import { WriteOperation, WriteConfirmationError, type WriteDependencies } from '../src/sink/writeOperation.js'

const hash = ('0x' + 'ab'.repeat(32)) as Hex
type Result = { txHash: Hex }
function fixture(mode: 'non-gas' | 'gas' | 'disagrees' | 'null' | 'uncertain') {
  let sends = 0, prepares = 0
  const operation = new WriteOperation<Result>()
  const deps: WriteDependencies<Result> = {
    prepare: async previous => { prepares++; return { gas: previous ? 2n * previous : 1_000_000n, gasPrice: 1n, nonce: sends } },
    send: async () => {
      sends++
      if (mode === 'uncertain') throw new Error('Transport timeout without a hash')
      if (mode === 'non-gas' || mode === 'gas' && sends === 1) throw new EntityMutationError('Confirmed revert', { txHash: hash })
      return { txHash: hash }
    },
    receipt: async () => mode === 'null' ? null : {
      status: mode === 'non-gas' || mode === 'disagrees' || mode === 'gas' && sends === 1 ? 'reverted' : 'success',
      gasUsed: mode === 'non-gas' ? 999_999n : 1_000_000n,
    },
    confirmedRevertHash: error => error instanceof EntityMutationError ? error.txHash : undefined,
  }
  return { operation, deps, sends: () => sends, prepares: () => prepares }
}
for (const [mode, sends, state] of [
  ['non-gas', 1, 'failed'], ['gas', 2, 'confirmed'], ['disagrees', 1, 'pending'],
  ['null', 1, 'pending'], ['uncertain', 1, 'uncertain'],
] as const) {
  const f = fixture(mode)
  const first = f.operation.run(f.deps)
  assert.equal(f.operation.state, 'sending', 'guard set synchronously')
  if (mode === 'gas') await first
  else await assert.rejects(first, WriteConfirmationError)
  // Same operation, another click: even a null/disagreeing receipt never allows a resend.
  const second = f.operation.run(f.deps)
  assert.equal(second, first)
  await second.catch(() => undefined)
  assert.equal(f.sends(), sends)
  assert.equal(f.prepares(), sends)
  assert.equal(f.operation.state, state)
  if (mode !== 'uncertain') assert.equal(f.operation.txHash, hash)
  console.log(`PASS ${mode}: ${sends} send(s), ${state}, new click reuses original outcome`)
}
