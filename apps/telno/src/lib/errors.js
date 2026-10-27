export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (message, details) => new HttpError(409, 'conflict', message, details);
export const tooMany = (message = 'Too many requests') => new HttpError(429, 'rate_limited', message);

/** 402 is exactly what this means: the account exists, but it is not paid for. */
export const paymentRequired = (message = 'This account is suspended for non-payment') =>
  new HttpError(402, 'payment_required', message);

/**
 * 403 for an account that has signed in but not finished the first-login steps.
 *
 * Its own code rather than a plain `forbidden`, because the console has an
 * action to take: the wizard, opened at the step named in `details.next`.
 */
export const onboardingRequired = (next, message = 'Finish setting up your account to continue') =>
  new HttpError(403, 'onboarding_required', message, { next });

/** 403 with a reason the softphone can act on: it needs a voice check first. */
export const voiceRequired = (message = 'This line requires a voice check before it can be used') =>
  new HttpError(403, 'voice_required', message);

/** Wrap an async route so thrown HttpErrors reach the error handler. */
export const route = (fn) => async (request, reply) => fn(request, reply);
