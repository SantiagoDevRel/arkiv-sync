import type { Hex, TransactionReceipt } from 'viem'

export type WriteState = 'idle' | 'sending' | 'submitted' | 'confirmed' | 'pending' | 'uncertain' | 'failed'
export class WriteConfirmationError extends Error {
  constructor(readonly outcome: 'pending' | 'uncertain' | 'failed', readonly txHash?: Hex) {
    super(outcome === 'failed' ? 'Confirmed write failed; do not retry this operation.' :
      `Write ${outcome}; check before retrying${txHash ? `: ${txHash}` : ''}.`)
    this.name = 'WriteConfirmationError'
  }
}
export interface WriteDependencies<T extends { txHash: Hex }> {
  prepare(previousGas?: bigint): Promise<{ gas: bigint; gasPrice: bigint; nonce: number }>
  send(params: { gas: bigint; gasPrice: bigint; nonce: number }): Promise<T>
  receipt(hash: Hex): Promise<Pick<TransactionReceipt, 'status' | 'gasUsed'> | null>
  confirmedRevertHash(error: unknown): Hex | undefined
  errorHash?(error: unknown): Hex | undefined
}

/** Keep this object for the operation's whole lifetime, including new clicks/re-renders.
 * No receipt lookup after SDK success is allowed to re-enter the send path. */
export class WriteOperation<T extends { txHash: Hex }> {
  state: WriteState = 'idle'
  attempts = 0
  txHash?: Hex
  private promise?: Promise<T>

  run(deps: WriteDependencies<T>): Promise<T> {
    if (this.promise) return this.promise
    this.state = 'sending' // guard synchronously, before any network call
    this.promise = this.execute(deps)
    return this.promise
  }
  private async execute(deps: WriteDependencies<T>): Promise<T> {
    let previousGas: bigint | undefined
    while (this.attempts < 2) {
      let params: Awaited<ReturnType<typeof deps.prepare>>
      try { params = await deps.prepare(previousGas) }
      catch (error) { this.state = 'failed'; throw error } // unsigned: no send admitted
      this.attempts++
      let result: T
      try { result = await deps.send(params) }
      catch (error) {
        const hash = deps.confirmedRevertHash(error)
        this.txHash = hash ?? deps.errorHash?.(error)
        if (hash) {
          let receipt
          try { receipt = await deps.receipt(hash) } catch { /* uncertain */ }
          if (receipt?.status === 'reverted') {
            if (receipt.gasUsed === params.gas && this.attempts === 1) {
              previousGas = params.gas
              continue // prepare must re-estimate at latest and enforce the half-block ceiling
            }
            this.state = 'failed'
            throw new WriteConfirmationError('failed', hash)
          }
        }
        this.state = 'uncertain'
        throw new WriteConfirmationError('uncertain', this.txHash)
      }
      this.txHash = result.txHash
      this.state = 'submitted' // stored BEFORE lookup: SDK success is irrevocable
      let receipt
      try { receipt = await deps.receipt(result.txHash) } catch { /* pending */ }
      if (!receipt || receipt.status !== 'success') {
        this.state = 'pending'
        throw new WriteConfirmationError('pending', result.txHash)
      }
      this.state = 'confirmed'
      return result
    }
    this.state = 'failed'
    throw new WriteConfirmationError('failed', this.txHash)
  }
}
