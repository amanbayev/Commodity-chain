export class InstrumentCommandQueue {
  private readonly tails = new Map<string, Promise<void>>();

  public async run<T>(instrumentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(instrumentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(instrumentId, current);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(instrumentId) === current) this.tails.delete(instrumentId);
    }
  }
}
