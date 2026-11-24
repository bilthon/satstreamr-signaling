import { createHmac } from 'crypto';

export function generateTurnCredentials(
  sharedSecret: string,
  userId: string,
  ttlSeconds = 3600,
): { username: string; credential: string } {
  const expiryTimestamp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiryTimestamp}:${userId}`;
  const credential = createHmac('sha1', sharedSecret)
    .update(username)
    .digest('base64');
  return { username, credential };
}
