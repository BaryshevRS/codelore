export type CodeloreErrorCode =
  | "AMBIGUOUS_BLOCK"
  | "AMBIGUOUS_SECTION"
  | "BROKEN_DOC_REFERENCE"
  | "DUPLICATE_SECTION"
  | "INTERNAL_ERROR"
  | "INVALID_LLM_RESPONSE"
  | "LLM_PROVIDER_ERROR"
  | "MISSING_LLM_API_KEY"
  | "UNKNOWN_LLM_PROVIDER"
  | "MISSING_BLOCK"
  | "MISSING_GENERATED_BLOCKS"
  | "NO_DOCUMENTED_FILES"
  | "NO_DOMAIN_MAP"
  | "PARTITION_TOO_LARGE"
  | "UNKNOWN_CHANGE"
  | "UNKNOWN_DOC"
  | "UNKNOWN_ENTITY"
  | "UNKNOWN_SECTION"
  | "UNSAFE_REPLACEMENT"
  | "UNSUPPORTED_STATE_VERSION";

export interface CodeloreErrorPayload {
  code: CodeloreErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class CodeloreError extends Error {
  readonly code: CodeloreErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CodeloreErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CodeloreError";
    this.code = code;
    this.details = details;
  }
}

export function toCodeloreErrorPayload(error: unknown): CodeloreErrorPayload {
  if (error instanceof CodeloreError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}
