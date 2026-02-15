import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const PASSWORD_KEY_LENGTH = 64;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

const jwtSecret = process.env.JWT_SECRET as string;
if (!jwtSecret) {
  throw new Error('JWT_SECRET is required to start the API.');
}

export type AuthUser = {
  id: string;
  username: string;
};

type TokenPayload = {
  sub: string;
  username: string;
  type: 'access' | 'refresh';
  iat: number;
  exp: number;
  jti?: string;
};

type TokenType = TokenPayload['type'];

function encodeBase64Url(value: string) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signToken(payload: TokenPayload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', jwtSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyToken(token: string, expectedType: TokenType) {
  const [encodedHeader, encodedPayload, providedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !providedSignature) {
    throw new Error('Invalid token format.');
  }

  const expectedSignature = createHmac('sha256', jwtSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new Error('Invalid token signature.');
  }

  const payload = JSON.parse(decodeBase64Url(encodedPayload)) as TokenPayload;
  if (payload.type !== expectedType) {
    throw new Error('Invalid token type.');
  }

  if (!payload.sub || !payload.username || !payload.exp || !payload.iat) {
    throw new Error('Invalid token payload.');
  }

  if (Date.now() >= payload.exp * 1000) {
    throw new Error('Token expired.');
  }

  return payload;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [salt, key] = storedHash.split(':');
  if (!salt || !key) {
    return false;
  }

  const derivedKey = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
  const keyBuffer = Buffer.from(key, 'hex');

  if (keyBuffer.length !== derivedKey.length) {
    return false;
  }

  return timingSafeEqual(keyBuffer, derivedKey);
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function createAccessToken(user: AuthUser) {
  const iat = Math.floor(Date.now() / 1000);
  return signToken({
    sub: user.id,
    username: user.username,
    type: 'access',
    iat,
    exp: iat + ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function createRefreshToken(user: AuthUser, tokenId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return signToken({
    sub: user.id,
    username: user.username,
    type: 'refresh',
    iat,
    exp: iat + REFRESH_TOKEN_TTL_SECONDS,
    jti: tokenId,
  });
}

export function verifyAccessToken(token: string) {
  const payload = verifyToken(token, 'access');

  return {
    userId: payload.sub,
    username: payload.username,
  };
}

export function verifyRefreshToken(token: string) {
  const payload = verifyToken(token, 'refresh');

  if (!payload.jti) {
    throw new Error('Invalid refresh token payload.');
  }

  return {
    userId: payload.sub,
    username: payload.username,
    tokenId: payload.jti,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

export const accessTokenTtlSeconds = ACCESS_TOKEN_TTL_SECONDS;
export const refreshTokenTtlSeconds = REFRESH_TOKEN_TTL_SECONDS;
