export class ApplicationError extends Error {
  constructor(
    public readonly code:
      'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}
