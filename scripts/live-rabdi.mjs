import assert from 'node:assert/strict'
import { ArkivSink, createArkivReader, silentLogger, RABDI_MAX_LIFETIME_BLOCKS, scrubSecrets } from '../dist/index.js'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http } from 'viem'
import { rabdi } from '@arkiv-network/sdk/chains'

const privateKey = process.env.TEST_SYNC_PRIVATE_KEY
const accessKey = process.env.ARKIV_ACCESS_KEY_A
if (!privateKey || !accessKey) throw new Error('Live integration requires the authorized TEST_SYNC wallet and Key A.')
try {
  const account = privateKeyToAccount(privateKey)
  assert.equal(account.address.toLowerCase(), process.env.TEST_SYNC_ADDRESS?.toLowerCase())
  const chain = rabdi({ accessKey })
  const rpc = createPublicClient({ chain, transport: http(undefined, { retryCount: 0 }) })
  assert.equal(await rpc.getChainId(), 7794095)
  const sink = new ArkivSink({ account, accessKey, logger: silentLogger })
  const data = { eventId: 'rabdi-sync-lifetime-proof-v1', attributes: [{ key: 'sync', value: 'rabdi-lifetime-proof-v1' }],
    data: { purpose: 'maximum permitted lifetime proof' }, expiresInSeconds: Number((RABDI_MAX_LIFETIME_BLOCKS - 30n) * 2n) }
  const write = await sink.write(data)
  const replay = await sink.write(data)
  assert.equal(replay.op, 'skip')
  let receipt, transaction
  if (write.txHash) {
    receipt = await rpc.getTransactionReceipt({ hash: write.txHash })
    transaction = await rpc.getTransaction({ hash: write.txHash })
    assert.equal(receipt.status, 'success')
    assert(transaction.gas >= 1_000_000n)
    assert(transaction.gas >= 2n * receipt.gasUsed)
    const head = await rpc.getBlock({ blockTag: 'latest' })
    assert(transaction.gas <= head.gasLimit / 2n)
  }
  const rows = await createArkivReader({ accessKey }).query("event_id = str('rabdi-sync-lifetime-proof-v1')", { owner: account.address })
  assert.equal(rows.length, 1)
  const head = await rpc.getBlockNumber({ cacheTime: 0 })
  const remaining = BigInt(rows[0].expiresAtBlock) - head
  assert(remaining > RABDI_MAX_LIFETIME_BLOCKS - 1000n && remaining <= RABDI_MAX_LIFETIME_BLOCKS)
  await assert.rejects(sink.write({ ...data, eventId: 'refused-too-long', expiresInSeconds: Number(RABDI_MAX_LIFETIME_BLOCKS * 2n) }), /maxLifetime/)
  console.log(JSON.stringify({ status: 'PASS', owner: account.address, operation: write.op, replay: replay.op, txHash: write.txHash,
    key: rows[0].key, expiresAtBlock: rows[0].expiresAtBlock, remainingBlocks: String(remaining),
    receipt: receipt && { status: receipt.status, blockNumber: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed), gasLimit: String(transaction.gas) } }))
} catch (error) { console.error(scrubSecrets(error)); process.exitCode = 1 }
