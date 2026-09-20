export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
    readonly type: string = `https://aedresponse.invalid/problems/${status}`
  ) {
    super(detail);
    this.name = "HttpProblem";
  }

  toJSON(): { type: string; title: string; status: number; detail: string } {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.detail
    };
  }
}

export function badRequest(detail: string): HttpProblem {
  return new HttpProblem(400, "Invalid request", detail);
}

export function unauthorized(detail = "A valid authenticated session is required"): HttpProblem {
  return new HttpProblem(401, "Unauthorized", detail);
}

export function authenticationUnavailable(provider: "PHONE" | "APPLE" | "WATCH" | "CONTROLLED_TEST"): HttpProblem {
  return new HttpProblem(
    503,
    "Authentication unavailable",
    `${provider} authentication is not configured on this backend`
  );
}

export function forbidden(detail: string): HttpProblem {
  return new HttpProblem(403, "Forbidden", detail);
}

export function notFound(detail: string): HttpProblem {
  return new HttpProblem(404, "Not found", detail);
}

export function conflict(detail: string): HttpProblem {
  return new HttpProblem(409, "Conflict", detail);
}

export function soleResponderConfirmationRequired(): HttpProblem {
  return new HttpProblem(
    409,
    "Sole responder confirmation required",
    "你是当前任务唯一一名响应者，确定要退出吗。",
    "https://aedresponse.invalid/problems/sole-responder-confirmation-required"
  );
}

export function tooEarly(detail: string): HttpProblem {
  return new HttpProblem(
    425,
    "Too Early",
    detail,
    "https://aedresponse.invalid/problems/too-early"
  );
}

export function unprocessableEntity(detail: string): HttpProblem {
  return new HttpProblem(
    422,
    "Unprocessable Entity",
    detail,
    "https://aedresponse.invalid/problems/unprocessable-entity"
  );
}

export function tooManyRequests(detail: string): HttpProblem {
  return new HttpProblem(429, "Too many requests", detail);
}

export function payloadTooLarge(detail = "JSON request body exceeds 16 KiB"): HttpProblem {
  return new HttpProblem(
    413,
    "Payload too large",
    detail,
    "https://aedresponse.invalid/problems/payload-too-large"
  );
}
