import { MissingAccessKeyError } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import type { Chain } from 'viem'

export interface ArkivNetwork {
  chain: Chain
  name: string
  isTestnet: boolean
  explorerUrl?: string
  faucetUrl?: string
}
export const RABDI_CHAIN_ID = 7794095
export const RABDI_EXPLORER_URL = 'https://rabdi.explorer.arkiv.network'
export const RABDI_MAX_LIFETIME_BLOCKS = 7_884_000n

/** Build lazily: importing the library must never need credentials or make requests. */
export function createRabdiNetwork(accessKey = process.env.ARKIV_ACCESS_KEY): ArkivNetwork {
  if (!accessKey?.trim()) throw new MissingAccessKeyError('Rabdi')
  return {
    chain: rabdi({ accessKey }), name: 'arkiv:rabdi', isTestnet: true,
    explorerUrl: RABDI_EXPLORER_URL, faucetUrl: 'https://hub.arkiv.network/faucet',
  }
}
