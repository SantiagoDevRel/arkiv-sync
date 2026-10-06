/** A write was admitted. Stop until its chain outcome and original input are reconciled. */
export class WriteReconciliationRequiredError extends Error {
  readonly requiresReconciliation = true
  readonly txHash?: string
  constructor(message: string, options: { cause?: unknown; txHash?: string } = {}) {
    super(message, { cause: options.cause })
    this.name = 'WriteReconciliationRequiredError'
    this.txHash = options.txHash
  }
}
