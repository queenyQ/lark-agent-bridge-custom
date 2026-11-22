import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { hostname, userInfo } from 'node:os';
import type { AppPaths } from './app-paths';
import { paths } from './paths';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * Version 1 derives its key from the hostname and salt.
 * Version 2 uses a private random key beside the encrypted store.
 * Back up the key together with the ciphertext to recover a version 2 store.
 */
const KEY_LEN = 32;
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16; // GCM auth tag
const PBKDF2_ITER = 100_000;
const FILE_VERSION = 2;
const derivedKeyCache = new Map<string, Buffer>();

interface Envelope {
  /** base64 of 12-byte IV */
  iv: string;
  /** base64 of ciphertext */
  data: string;
  /** base64 of 16-byte GCM auth tag */
  tag: string;
}

interface StoreFile {
  version: number;
  entries: Record<string, Envelope>;
}

export type KeystorePaths = Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile'>;

/** Read + return the full keystore. Missing file or unreadable → empty store. */
async function readStore(storePaths: KeystorePaths = paths): Promise<StoreFile> {
  try {
    const text = await readFile(storePaths.secretsFile, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    if (![1, FILE_VERSION].includes(parsed?.version ?? 0) || !parsed.entries) {
      throw new Error('Unsupported or invalid keystore format. Restore a backup before writing.');
    }
    return { version: parsed.version!, entries: { ...parsed.entries } };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw err;
  }
}

function emptyStore(): StoreFile {
  return { version: FILE_VERSION, entries: {} };
}

async function writeStore(store: StoreFile, storePaths: KeystorePaths = paths): Promise<void> {
  await writeFileAtomic(storePaths.secretsFile, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Legacy salts must survive until every version 1 store has migrated. */
async function loadOrCreateSalt(storePaths: KeystorePaths = paths): Promise<Buffer> {
  const salt = await readFile(storePaths.keystoreSaltFile);
  if (salt.length !== KEY_LEN) throw new Error('Invalid legacy keystore salt. Restore the salt backup.');
  return salt;
}

async function deriveKey(storePaths: KeystorePaths = paths, legacyHostname = hostname()): Promise<Buffer> {
  const cacheKey = `${storePaths.keystoreSaltFile}|${legacyHostname}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;
  const salt = await loadOrCreateSalt(storePaths);
  const seed = `${legacyHostname}|${userInfo().username}`;
  const key = pbkdf2Sync(seed, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
  derivedKeyCache.set(cacheKey, key);
  return key;
}

async function withStoreLock<T>(storePaths: KeystorePaths, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(storePaths.secretsFile), { recursive: true, mode: 0o700 });
  const target = `${storePaths.secretsFile}.write-lock`;
  await writeFile(target, '', { flag: 'a', mode: 0o600 });
  const release = await lockfile.lock(target, {
    realpath: false,
    retries: { retries: 20, minTimeout: 25, maxTimeout: 100 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

function masterKeyPath(storePaths: KeystorePaths): string {
  return join(dirname(storePaths.secretsFile), '.keystore.key');
}

async function stableKey(storePaths: KeystorePaths, create: boolean): Promise<Buffer> {
  const file = masterKeyPath(storePaths);
  try {
    const key = await readFile(file);
    if (key.length !== KEY_LEN) throw new Error('Invalid keystore key. Restore the key backup.');
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (!create) throw new Error('Keystore key is missing. Restore .keystore.key or rebind the profile.');
  }
  const key = randomBytes(KEY_LEN);
  await writeFileAtomic(file, key, { mode: 0o600 });
  return key;
}

async function upgradeStore(store: StoreFile, storePaths: KeystorePaths, legacyHostname?: string): Promise<Buffer> {
  if (store.version === FILE_VERSION) {
    return stableKey(storePaths, Object.keys(store.entries).length === 0);
  }
  const oldKey = await deriveKey(storePaths, legacyHostname);
  const plaintext = Object.entries(store.entries).map(([id, value]) => [id, decrypt(oldKey, value)] as const);
  const original = await readFile(storePaths.secretsFile);
  const backup = `${storePaths.secretsFile}.v1.bak`;
  try {
    await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!(await readFile(backup)).equals(original)) {
      throw new Error('Legacy backup differs from the current store. Preserve it before retrying migration.');
    }
  }
  const key = await stableKey(storePaths, true);
  store.entries = Object.fromEntries(plaintext.map(([id, value]) => [id, encrypt(key, value)]));
  for (const [id, value] of plaintext) {
    if (decrypt(key, store.entries[id]!) !== value) throw new Error('Keystore migration verification failed.');
  }
  store.version = FILE_VERSION;
  return key;
}

export async function migrateKeystore(
  storePaths: KeystorePaths = paths,
  legacyHostname?: string,
): Promise<void> {
  await withStoreLock(storePaths, async () => {
    const store = await readStore(storePaths);
    await upgradeStore(store, storePaths, legacyHostname);
    await writeStore(store, storePaths);
  });
}

function encrypt(key: Buffer, plaintext: string): Envelope {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    data: enc.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decrypt(key: Buffer, env: Envelope): string {
  const iv = Buffer.from(env.iv, 'base64');
  const data = Buffer.from(env.data, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  if (iv.length !== IV_LEN) throw new Error('invalid IV length');
  if (tag.length !== TAG_LEN) throw new Error('invalid auth tag length');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

/** Look up an entry by id (e.g. "app-cli_xxx"). Returns plaintext or
 * `undefined` when not present. Errors (decryption failure, invalid file)
 * propagate. */
export async function getSecret(
  id: string,
  storePaths: KeystorePaths = paths,
): Promise<string | undefined> {
  const store = await readStore(storePaths);
  const env = store.entries[id];
  if (!env) return undefined;
  const key = store.version === 1 ? await deriveKey(storePaths) : await stableKey(storePaths, false);
  try {
    return decrypt(key, env);
  } catch (err) {
    if (store.version === 1) {
      throw new Error('Legacy keystore could not be decrypted. Run secrets migrate --legacy-hostname <previous-hostname>, or rebind the profile.');
    }
    throw err;
  }
}

/** Store / overwrite the secret for `id`. */
export async function setSecret(
  id: string,
  plaintext: string,
  storePaths: KeystorePaths = paths,
): Promise<void> {
  await withStoreLock(storePaths, async () => {
    const store = await readStore(storePaths);
    const key = await upgradeStore(store, storePaths);
    store.entries[id] = encrypt(key, plaintext);
    await writeStore(store, storePaths);
  });
}

/** Remove an entry. Returns true if something was removed. */
export async function removeSecret(
  id: string,
  storePaths: KeystorePaths = paths,
): Promise<boolean> {
  return withStoreLock(storePaths, async () => {
    const store = await readStore(storePaths);
    if (!(id in store.entries)) return false;
    await upgradeStore(store, storePaths);
    delete store.entries[id];
    await writeStore(store, storePaths);
    return true;
  });
}

/** List ids (no secrets in the output, by design). */
export async function listSecretIds(storePaths: KeystorePaths = paths): Promise<string[]> {
  const store = await readStore(storePaths);
  return Object.keys(store.entries);
}

export function clearKeystoreDerivedKeyCache(): void {
  derivedKeyCache.clear();
}

export function keystoreDerivedKeyCacheSize(): number {
  return derivedKeyCache.size;
}
