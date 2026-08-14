export class SettlementError extends Error {
  public constructor(
    public readonly code:
      | 'INVALID_SETTLEMENT_TRANSITION'
      | 'SETTLEMENT_NOT_FOUND'
      | 'SETTLEMENT_EVENT_MISMATCH'
      | 'SETTLEMENT_ACCOUNTS_NOT_CONFIGURED'
      | 'SETTLEMENT_NOT_FUNDED'
      | 'SETTLEMENT_ACCOUNT_CONFIGURATION_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'SettlementError';
  }
}
