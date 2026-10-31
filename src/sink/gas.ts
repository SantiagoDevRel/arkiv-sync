import { createWalletClient, type ExecuteBatchParameters, type PublicArkivClient,
  type TxParams } from '@arkiv-network/sdk'
import { createPublicClient as createEvmClient, custom, numberToHex, type Account, type Hex } from 'viem'

export class GasBudgetError extends Error {}
export type GasOverride = TxParams
export const MIN_WRITE_GAS = 1_000_000n

/** Ask the SDK to encode the exact unsigned batch with a JSON-RPC capture account.
 * The isolated transport intercepts eth_sendTransaction and NEVER broadcasts or signs.
 * This avoids copying private SDK ABI encoders into the library. */
export async function encodeUnsignedBatch(pub: PublicArkivClient, account: Account, batch: ExecuteBatchParameters): Promise<{ to: Hex; data: Hex }> {
  let captured: { to: Hex; data: Hex } | undefined
  const capture = createWalletClient({ chain: pub.chain, account: { address: account.address, type: 'json-rpc' },
    transport: custom({ request: async ({ method, params }) => {
      if (method === 'eth_sendTransaction') {
        const request = (params as [{ to: Hex; data: Hex }])[0]
        captured = { to: request.to, data: request.data }
        throw new Error('Unsigned encoding captured; broadcasting prohibited.')
      }
      if (method === 'eth_sendRawTransaction') throw new Error('Raw broadcast prohibited in unsigned encoder.')
      if (method === 'eth_chainId') return numberToHex(await pub.getChainId())
      if (method !== 'eth_blockNumber') throw new Error(`Unexpected unsigned encoding request: ${method}`)
      return numberToHex(await pub.getBlockNumber({ cacheTime: 0 }))
    } }, { retryCount: 0 }) })
  try { await capture.executeBatch(batch, { gas: MIN_WRITE_GAS, gasPrice: 1n, nonce: 0 }) }
  catch (error) { if (!captured) throw error }
  if (!captured) throw new Error('SDK did not expose an unsigned transaction.')
  return captured
}

export async function prepareGas(pub: PublicArkivClient, account: Account, batch: ExecuteBatchParameters,
  override: TxParams = {}, previousGas?: bigint) {
  const unsigned = await encodeUnsignedBatch(pub, account, batch)
  // An estimate error stops admission. Never fall back to a guessed gas limit.
  const evm = createEvmClient({ chain: pub.chain, transport: custom(pub.transport, { retryCount: 0 }) })
  const estimate = await evm.estimateGas({ ...unsigned, account: account.address, blockTag: 'latest' })
  const head = await pub.getBlock({ blockTag: 'latest' })
  const gas = [MIN_WRITE_GAS, 2n * estimate, override.gas ?? 0n, previousGas ? 2n * previousGas : 0n]
    .reduce((a, b) => a > b ? a : b)
  if (gas > head.gasLimit / 2n) throw new GasBudgetError('Write exceeds half the head block gas limit; split the batch or reduce entity size.')
  if (override.maxFeePerGas !== undefined || override.maxPriorityFeePerGas !== undefined) throw new Error('Rabdi writes require an explicit legacy gasPrice.')
  const gasPrice = override.gasPrice ?? await evm.getGasPrice()
  const nonce = previousGas !== undefined ? await pub.getTransactionCount({ address: account.address, blockTag: 'latest' }) :
    override.nonce ?? await pub.getTransactionCount({ address: account.address, blockTag: 'latest' })
  return { gas, gasPrice, nonce }
}
