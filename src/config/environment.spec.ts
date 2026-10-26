import { validateEnvironment } from './environment.js';

describe('environment validation', () => {
  it.each(['0', '65536', '-1', '1.5', 'abc'])(
    'rejects invalid port %s',
    (port) => {
      expect(() => validateEnvironment({ PORT: port })).toThrow(
        'PORT must be an integer between 1 and 65535',
      );
    },
  );

  it('rejects unsupported environments and invalid URLs', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'staging' })).toThrow(
      'NODE_ENV must be development, test, or production',
    );
    expect(() => validateEnvironment({ SQS_ENDPOINT: 'not a url' })).toThrow(
      'SQS_ENDPOINT must be a valid URL',
    );
  });

  it('requires explicit production configuration', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow(
      'DATABASE_HOST is required when NODE_ENV=production',
    );
  });

  it('accepts local defaults outside production', () => {
    expect(validateEnvironment({ NODE_ENV: 'test' })).toEqual({
      NODE_ENV: 'test',
    });
  });
});
