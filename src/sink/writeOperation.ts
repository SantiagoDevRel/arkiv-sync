import type { Hex, TransactionReceipt } from 'viem'

export type WriteState = 'idle' | 'sending' | 'submitted' | 'confirmed' | 'pending' | 'uncertain' | 'failed' | 'retryable'
export interface OperationSnapshot<T> {
  state: WriteState; attempts: number; txHash?: Hex; gas?: string; nonce?: number
  sdkAcknowledged?: boolean; result?: T
}
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
  private gas?: string
  private nonce?: number
  private sdkAcknowledged = false
  private result?: T
  constructor(snapshot?: OperationSnapshot<T>, private readonly persist?: (value: OperationSnapshot<T>) => Promise<void>) {
    if (snapshot) {
      this.state = snapshot.state; this.attempts = snapshot.attempts; this.txHash = snapshot.txHash
      this.gas = snapshot.gas; this.nonce = snapshot.nonce; this.sdkAcknowledged = snapshot.sdkAcknowledged ?? false; this.result = snapshot.result
      if (this.state === 'failed' && this.attempts === 0) this.state = 'idle' // unsigned preparation never admitted a wallet send
    }
  }
  private save(): Promise<void> {
    return this.persist?.({ state: this.state, attempts: this.attempts, txHash: this.txHash,
      gas: this.gas, nonce: this.nonce, sdkAcknowledged: this.sdkAcknowledged, result: this.result }) ?? Promise.resolve()
  }
  /** Called by the wallet transport immediately after a broadcast hash, BEFORE the SDK's
   * own receipt polling. A failed journal write leaves the durable pre-send lock in place. */
  async broadcast(hash: Hex): Promise<void> { this.txHash = hash; this.state = 'submitted'; await this.save() }

  run(deps: WriteDependencies<T>): Promise<T> {
    if (this.promise) return this.promise
    if (this.state === 'confirmed' && this.result) return Promise.resolve(this.result)
    if (!['idle', 'retryable'].includes(this.state)) return Promise.reject(new WriteConfirmationError(
      this.state === 'failed' ? 'failed' : this.sdkAcknowledged || this.state === 'pending' || this.state === 'submitted' ? 'pending' : 'uncertain', this.txHash))
    const previousGas = this.state === 'retryable' && this.gas ? BigInt(this.gas) : undefined
    this.state = 'sending' // guard synchronously, before any network call
    this.promise = this.execute(deps, previousGas)
    return this.promise
  }
  private async execute(deps: WriteDependencies<T>, previousGas?: bigint): Promise<T> {
    await this.save() // admission lock is durable before network preparation
    while (this.attempts < 2) {
      let params: Awaited<ReturnType<typeof deps.prepare>>
      try { params = await deps.prepare(previousGas) }
      catch (error) { this.state = 'failed'; await this.save(); throw error } // unsigned: no send admitted
      this.attempts++
      this.gas = params.gas.toString(); this.nonce = params.nonce
      this.state = 'sending'; this.sdkAcknowledged = false
      await this.save() // attempt budget is durable BEFORE the wallet can broadcast
      let result: T
      try { result = await deps.send(params) }
      catch (error) {
        const hash = deps.confirmedRevertHash(error)
        this.txHash = hash ?? deps.errorHash?.(error) ?? this.txHash
        if (hash) {
          let receipt
          try { receipt = await deps.receipt(hash) } catch { /* uncertain */ }
          if (receipt?.status === 'reverted') {
            if (receipt.gasUsed === params.gas && this.attempts === 1) {
              previousGas = params.gas
              this.state = 'retryable'; await this.save()
              continue // prepare must re-estimate at latest and enforce the half-block ceiling
            }
            this.state = 'failed'
            await this.save()
            throw new WriteConfirmationError('failed', hash)
          }
        }
        this.state = 'uncertain'
        await this.save()
        throw new WriteConfirmationError('uncertain', this.txHash)
      }
      this.txHash = result.txHash
      this.state = 'submitted' // stored BEFORE lookup: SDK success is irrevocable
      this.sdkAcknowledged = true; this.result = result
      await this.save()
      let receipt
      try { receipt = await deps.receipt(result.txHash) } catch { /* pending */ }
      if (!receipt || receipt.status !== 'success') {
        this.state = 'pending'
        await this.save()
        throw new WriteConfirmationError('pending', result.txHash)
      }
      this.state = 'confirmed'
      await this.save()
      return result
    }
    this.state = 'failed'
    throw new WriteConfirmationError('failed', this.txHash)
  }
}
