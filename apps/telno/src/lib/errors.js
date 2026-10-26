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

/** Wrap an async route so thrown HttpErrors reach the error handler. */
export const route = (fn) => async (request, reply) => fn(request, reply);
