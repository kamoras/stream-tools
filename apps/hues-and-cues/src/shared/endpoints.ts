/**
 * Runtime constants needed by the browser. Kept free of dependencies so that
 * importing them never pulls server-side libraries (zod) into the bundle.
 */
export const WS_PATH = '/ws';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 24;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;
