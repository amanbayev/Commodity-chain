export interface ESignAdapter {
  healthCheck(): Promise<void>;
}

export class MockESignAdapter implements ESignAdapter {
  public healthCheck(): Promise<void> {
    return Promise.resolve();
  }
}
