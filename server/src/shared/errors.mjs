export class AppError extends Error {
  constructor(message, code, status = 500, details = undefined) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, "VALIDATION_ERROR", 422, details);
  }
}

export class KoharuError extends AppError {
  constructor(message, status = 502, details) {
    super(message, "KOHARU_ERROR", status, details);
  }
}

export class EngineError extends AppError {
  constructor(message, status = 502, details) {
    super(message, "ENGINE_ERROR", status, details);
  }
}

export class TimeoutError extends AppError {
  constructor(message) {
    super(message, "TIMEOUT", 504);
  }
}

export class ProviderApiError extends AppError {
  constructor(message, details) {
    super(message, "PROVIDER_API_ERROR", 502, details);
  }
}
