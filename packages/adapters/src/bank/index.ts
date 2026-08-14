export interface BankAdapter {
  healthCheck(): Promise<void>;
}

export class MockBankAdapter implements BankAdapter {
  public healthCheck(): Promise<void> {
    return Promise.resolve();
  }
}
