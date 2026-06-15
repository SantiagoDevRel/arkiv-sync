import {
  BlockNotFoundError,
  createPublicClient,
  type AbiEvent,
  type Address,
  type Log,
  type PublicClient,
} from 'viem'
import type { BlockHeader, Hex, Logger, NormalizedEvent, SourceAdapter } from '../types.js'
import { eventId, lower, scrubSecrets } from '../util.js'
import { buildReadTransport } from './rpcPool.js'
import { resolveSourceChain, type SourceChainDef } from './chains.js'

export interface EvmSourceOptions {
  chain: string | SourceChainDef
  /** Contract address(es) to watch. */
  addresses: Hex[]
  /** Parsed ABI events to decode. */
  events: AbiEvent[]
  /** Override the public RPC pool with your own endpoint(s). */
  rpcUrls?: string[]
  /** Max blocks per getLogs request. Auto-halves on RPC range limits. Default 2000. */
  batchSize?: number
  logger: Logger
}

/** Heuristic: does this RPC error mean "your block range / result set is too big"? */
function isRangeError(err: unknown): boolean {
  const m = scrubSecrets(err).toLowerCase()
  return (
    m.includes('too large') ||
    m.includes('range') ||
    m.includes('limit') ||
    m.includes('more than') ||
    m.includes('10000') ||
    m.includes('result set') ||
    m.includes('query returned more')
  )
}

/**
 * EVM source adapter — reads + decodes events for the configured contract(s) on one chain.
 * Hides RPC rotation (fallback transport) and RPC range caps (auto block-range splitting),
 * so the core indexer just asks for "events between block X and Y".
 */
export class EvmSource implements SourceAdapter {
  readonly chainId: number
  readonly name: string
  private readonly client: PublicClient
  private readonly addresses: Address[]
  private readonly events: AbiEvent[]
  private readonly batchSize: number
  private readonly log: Logger
  private readonly chainDef: SourceChainDef

  constructor(opts: EvmSourceOptions) {
    this.chainDef = resolveSourceChain(opts.chain)
    this.chainId = this.chainDef.chain.id
    this.name = this.chainDef.key
    this.log = opts.logger
    this.addresses = opts.addresses.map((a) => lower(a)) as Address[]
    this.events = opts.events
    this.batchSize = Math.max(1, opts.batchSize ?? 2000)
    const urls = opts.rpcUrls?.length ? opts.rpcUrls : this.chainDef.defaultRpcUrls
    this.client = createPublicClient({
      chain: this.chainDef.chain,
      transport: buildReadTransport(urls),
    })
  }

  async preflight(): Promise<void> {
    let actual: number
    try {
      actual = await this.client.getChainId()
    } catch (err) {
      throw new Error(
        `Couldn't reach any ${this.name} RPC. Check your connection, or set SEPOLIA_RPC_URL ` +
          `to your own endpoint. (${scrubSecrets(err)})`,
      )
    }
    if (actual !== this.chainId) {
      throw new Error(
        `The configured ${this.name} RPC reports chainId ${actual}, expected ${this.chainId}. ` +
          `Refusing to index against the wrong chain.`,
      )
    }
    if (!this.addresses.length) {
      throw new Error('No contract address configured to index.')
    }
    if (!this.events.length) {
      throw new Error('No events configured to index.')
    }
    this.log.info(
      `source ready: ${this.name} (chainId ${this.chainId}), watching ${this.addresses.length} contract(s), ${this.events.length} event(s)`,
    )
  }

  async getHeadBlock(): Promise<bigint> {
    return this.client.getBlockNumber()
  }

  async getBlockHeader(blockNumber: bigint): Promise<BlockHeader | null> {
    try {
      const block = await this.client.getBlock({ blockNumber, includeTransactions: false })
      return { number: block.number!, hash: block.hash!, parentHash: block.parentHash }
    } catch (err) {
      // CRITICAL: only treat a genuinely-absent block as null (a real reorg signal). A transient
      // RPC error must THROW so the caller retries — otherwise a blip is misread as a reorg and we
      // roll back + delete + re-derive for nothing.
      if (err instanceof BlockNotFoundError) return null
      throw new Error(`getBlockHeader(${blockNumber}) failed: ${scrubSecrets(err)}`)
    }
  }

  async getEvents(fromBlock: bigint, toBlock: bigint): Promise<NormalizedEvent[]> {
    const logs = await this.getLogsSplit(fromBlock, toBlock)
    return logs.map((l) => this.normalize(l))
  }

  /** getLogs with automatic range-splitting when an RPC rejects a too-wide window. */
  private async getLogsSplit(fromBlock: bigint, toBlock: bigint): Promise<Log[]> {
    // Respect the configured batch size up front to avoid most range errors.
    if (toBlock - fromBlock + 1n > BigInt(this.batchSize)) {
      const mid = fromBlock + BigInt(this.batchSize) - 1n
      const head = await this.getLogsSplit(fromBlock, mid)
      const tail = await this.getLogsSplit(mid + 1n, toBlock)
      return [...head, ...tail]
    }
    try {
      return (await this.client.getLogs({
        address: this.addresses.length === 1 ? this.addresses[0] : this.addresses,
        events: this.events,
        fromBlock,
        toBlock,
        strict: true,
      })) as Log[]
    } catch (err) {
      if (fromBlock < toBlock && isRangeError(err)) {
        const mid = fromBlock + (toBlock - fromBlock) / 2n
        this.log.debug(`range ${fromBlock}-${toBlock} too wide, splitting at ${mid}`)
        const head = await this.getLogsSplit(fromBlock, mid)
        const tail = await this.getLogsSplit(mid + 1n, toBlock)
        return [...head, ...tail]
      }
      throw new Error(`Failed to read logs for blocks ${fromBlock}-${toBlock}: ${scrubSecrets(err)}`)
    }
  }

  private normalize(log: Log): NormalizedEvent {
    const anyLog = log as Log & {
      eventName?: string
      args?: Record<string, unknown> | readonly unknown[]
    }
    const txHash = (log.transactionHash ?? '0x') as Hex
    const logIndex = log.logIndex ?? 0
    // viem returns args as a named object when the event has named params.
    const args =
      anyLog.args && !Array.isArray(anyLog.args)
        ? (anyLog.args as Record<string, unknown>)
        : { _args: anyLog.args }
    return {
      eventId: eventId(this.chainId, txHash, logIndex),
      chainId: this.chainId,
      address: lower((log.address ?? '0x') as string),
      eventName: anyLog.eventName ?? 'UnknownEvent',
      args,
      blockNumber: log.blockNumber ?? 0n,
      blockHash: (log.blockHash ?? '0x') as Hex,
      transactionHash: txHash,
      logIndex,
      removed: Boolean(log.removed),
    }
  }
}
