export class CgptError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "CgptError"
  }
}

export const Codes = {
  Unbound: "UNBOUND_WORKSPACE",
  NotLoggedIn: "NOT_AUTHENTICATED",
  ProjectUnverifiable: "PROJECT_UNVERIFIABLE",
  ProtocolFailed: "PROTOCOL_FAILURE",
  MissingMetadata: "MISSING_METADATA",
  UnknownModel: "UNKNOWN_MODEL",
  BadRequest: "BAD_REQUEST",
  Unauthorized: "UNAUTHORIZED",
  Browser: "BROWSER_FAILURE",
  AmbiguousSubmit: "AMBIGUOUS_SUBMIT",
  AuthLost: "AUTH_LOST",
  Timeout: "TIMEOUT",
  State: "STATE_FAILURE",
  Config: "CONFIG_FAILURE",
} as const
