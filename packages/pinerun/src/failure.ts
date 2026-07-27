export type BarMagnifierFailureKind = 'unsupported' | 'malformed' | 'provider-limited';

/** Serializable permanent failure produced by pinerun's exact Bar Magnifier boundary. */
export interface BarMagnifierFailure {
  readonly type: 'bar-magnifier-error';
  readonly kind: BarMagnifierFailureKind;
  readonly code: string;
  readonly permanent: true;
  readonly message: string;
  readonly details?: unknown;
}

export class BarMagnifierError extends Error {
  readonly type = 'bar-magnifier-error' as const;
  readonly permanent = true as const;
  readonly kind: BarMagnifierFailureKind;
  readonly code: string;
  readonly details?: unknown;

  constructor(failure: Omit<BarMagnifierFailure, 'type' | 'permanent'>) {
    super(failure.message);
    this.name = 'BarMagnifierError';
    this.kind = failure.kind;
    this.code = failure.code;
    this.details = failure.details;
  }

  toJSON(): BarMagnifierFailure {
    return {
      type: this.type,
      kind: this.kind,
      code: this.code,
      permanent: this.permanent,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }

  static fromJSON(value: unknown): BarMagnifierError {
    if (!isBarMagnifierFailure(value)) {
      throw new TypeError('pinerun: invalid serialized Bar Magnifier error');
    }
    return new BarMagnifierError(value);
  }
}

export function isBarMagnifierFailure(value: unknown): value is BarMagnifierFailure {
  if (!isRecord(value)) return false;
  return (
    value.type === 'bar-magnifier-error' &&
    value.permanent === true &&
    (value.kind === 'unsupported' ||
      value.kind === 'malformed' ||
      value.kind === 'provider-limited') &&
    typeof value.code === 'string' &&
    value.code.length > 0 &&
    typeof value.message === 'string' &&
    value.message.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
