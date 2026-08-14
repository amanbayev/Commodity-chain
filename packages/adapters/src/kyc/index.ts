export interface KycAdapter {
  healthCheck(): Promise<void>;
}

export class MockKycAdapter implements KycAdapter {
  public healthCheck(): Promise<void> {
    return Promise.resolve();
  }
}
