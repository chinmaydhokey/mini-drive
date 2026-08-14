/**
 * Custom application error with HTTP status code.
 * Thrown in controllers/services, caught by the global error handler.
 */
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true; // distinguishes from programming errors
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
