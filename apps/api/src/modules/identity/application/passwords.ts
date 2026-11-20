import { hash, verify } from "@node-rs/argon2";

// Argon2id with OWASP-recommended parameters (m=19 MiB, t=2, p=1).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password).catch(() => false);
}

/** Used when the email is unknown so response timing does not reveal account existence. */
let dummyHash: Promise<string> | undefined;
export function verifyDummy(password: string): Promise<boolean> {
  dummyHash ??= hash("not-a-real-password-placeholder", OPTIONS);
  return dummyHash.then((h) => verifyPassword(h, password)).then(() => false);
}
