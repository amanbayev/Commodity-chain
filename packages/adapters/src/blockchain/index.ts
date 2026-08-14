export interface BlockchainAdapter {
  healthCheck(): Promise<void>;
}

export class MockBlockchainAdapter implements BlockchainAdapter {
  public healthCheck(): Promise<void> {
    return Promise.resolve();
  }
}
