export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "REQUEST_FAILED",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function invariant(
  condition: unknown,
  status: number,
  message: string,
  code?: string,
): asserts condition {
  if (!condition) {
    throw new ApiError(status, message, code);
  }
}
