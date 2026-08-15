export class ElevatorError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
    public readonly details: readonly Readonly<Record<string, unknown>>[] = [],
  ) {
    super(message);
    this.name = 'ElevatorError';
  }
}
