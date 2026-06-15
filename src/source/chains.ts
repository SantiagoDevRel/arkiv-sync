import type { Chain } from 'viem'
import { base, baseSepolia, bsc, bscTestnet, mainnet, sepolia } from 'viem/chains'

/**
 * Source chain registry. The SOURCE is READ-ONLY (getLogs) — reading mainnet logs signs nothing and
 * spends nothing, so indexing mainnet events is safe. The SINK (Arkiv/Braga) is always a testnet and
 * is the only thing that holds a key. Adding a chain is just an entry here (or a custom def in config);
 * the core indexer never changes.
 *
 * RPC lists are PUBLIC endpoints (no signup), verified live (eth_chainId) on 2026-06-15. The source
 * adapter wraps them in a viem `fallback` transport, so a dead/throttled endpoint is skipped silently.
 * `defaultConfirmations` = a sane reorg-safety depth per chain (override in config).
 */
export interface SourceChainDef {
  key: string
  chain: Chain
  defaultRpcUrls: string[]
  /** Blocks to stay behind the head before treating data as final (reorg safety). */
  defaultConfirmations: number
  /** True for mainnets — read-only here; surfaced so the UI/logs can label it. */
  isMainnet: boolean
}

// NOTE on RPCs (verified live + cross-checked 2026-06-15): BSC's official `bsc-dataseed*` seeds
// DISABLE `eth_getLogs` and `bsc-testnet.bnbchain.org` rate-limits it — so they're excluded here;
// publicnode/1rpc/drpc serve logs. Confirmations are reorg-safe defaults (the engine ALSO re-derives
// on reorg, so these balance safety vs latency; raise them for finality-grade guarantees).
export const SOURCE_CHAINS: Record<string, SourceChainDef> = {
  ethereum: {
    key: 'ethereum',
    chain: mainnet, // 1
    defaultRpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://1rpc.io/eth', 'https://eth.drpc.org'],
    defaultConfirmations: 24, // ~12s blocks; reorgs ~1-2 deep, full finality ~13min (64 blocks)
    isMainnet: true,
  },
  sepolia: {
    key: 'sepolia',
    chain: sepolia, // 11155111 (Ethereum testnet)
    defaultRpcUrls: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://1rpc.io/sepolia',
      'https://sepolia.drpc.org',
    ],
    defaultConfirmations: 6,
    isMainnet: false,
  },
  base: {
    key: 'base',
    chain: base, // 8453 (OP-stack L2)
    defaultRpcUrls: ['https://base-rpc.publicnode.com', 'https://1rpc.io/base', 'https://base.drpc.org'],
    defaultConfirmations: 40, // ~2s blocks; sequencer reorgs rare, L1 batch finality ~minutes
    isMainnet: true,
  },
  'base-sepolia': {
    key: 'base-sepolia',
    chain: baseSepolia, // 84532
    defaultRpcUrls: ['https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.drpc.org', 'https://sepolia.base.org'],
    defaultConfirmations: 40,
    isMainnet: false,
  },
  bsc: {
    key: 'bsc',
    chain: bsc, // 56 (PoSA) — bsc-dataseed seeds DISABLE eth_getLogs, so they're NOT used here
    defaultRpcUrls: ['https://bsc-rpc.publicnode.com', 'https://1rpc.io/bnb', 'https://bsc.drpc.org'],
    defaultConfirmations: 75, // sub-second blocks + PoSA can reorg deeper — stay well back
    isMainnet: true,
  },
  'bsc-testnet': {
    key: 'bsc-testnet',
    chain: bscTestnet, // 97
    defaultRpcUrls: ['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet.drpc.org'],
    defaultConfirmations: 75,
    isMainnet: false,
  },
}

export function resolveSourceChain(c: string | SourceChainDef): SourceChainDef {
  if (typeof c !== 'string') return c
  const def = SOURCE_CHAINS[c]
  if (!def) {
    const known = Object.keys(SOURCE_CHAINS).join(', ')
    throw new Error(
      `Unknown source chain "${c}". Built-in chains: ${known}. ` +
        `For another EVM chain, pass a chain definition object instead of a name ` +
        `(import a chain from "viem/chains" and provide defaultRpcUrls + defaultConfirmations).`,
    )
  }
  return def
}
