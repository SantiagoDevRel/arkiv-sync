import type { Chain } from 'viem'
import { sepolia } from 'viem/chains'

/**
 * Source chain registry. v1 ships Sepolia; adding Base/Arbitrum is literally a new
 * entry here (or a custom def passed in config) — the core indexer never changes.
 *
 * The RPC lists are PUBLIC endpoints that need no signup. The source adapter wraps them
 * in a viem `fallback` transport, so a dead/throttled endpoint is skipped automatically
 * and the user never sees a raw "Error: RPC ...". An own key can be added via config.
 */
export interface SourceChainDef {
  key: string
  chain: Chain
  defaultRpcUrls: string[]
}

export const SOURCE_CHAINS: Record<string, SourceChainDef> = {
  sepolia: {
    key: 'sepolia',
    chain: sepolia, // chainId 11155111
    defaultRpcUrls: [
      // Order = preference. Verified live (eth_chainId = 0xaa36a7) on 2026-06-14.
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://1rpc.io/sepolia',
      'https://sepolia.drpc.org',
      // Extra fallbacks (skipped automatically if down):
      'https://ethereum-sepolia.public.blastapi.io',
      'https://gateway.tenderly.co/public/sepolia',
    ],
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
        `(e.g. import a chain from "viem/chains" and provide defaultRpcUrls).`,
    )
  }
  return def
}
