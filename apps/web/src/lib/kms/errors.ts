export class KmsError extends Error {
  constructor(message = 'KMS error') {
    super(message);
    this.name = 'KmsError';
  }
}

export class KmsConfigurationError extends KmsError {
  constructor(message = 'KMS configuration is invalid') {
    super(message);
    this.name = 'KmsConfigurationError';
  }
}

export class KmsServiceError extends KmsError {
  constructor(message = 'KMS service is temporarily unavailable') {
    super(message);
    this.name = 'KmsServiceError';
  }
}

export class KmsDecryptionError extends KmsError {
  constructor(message = 'Encrypted secret could not be decrypted') {
    super(message);
    this.name = 'KmsDecryptionError';
  }
}
