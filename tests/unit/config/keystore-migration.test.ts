import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ value: 'before.local' }));
vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(),
  hostname: () => host.value,
}));
import { getSecret, setSecret, migrateKeystore, listSecretIds } from '../../../src/config/keystore';

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'keystore-migration-'));
  directories.push(directory);
  return {
    secretsFile: join(directory, 'secrets.enc'),
    keystoreSaltFile: join(directory, '.keystore.salt'),
  };
}
afterEach(async () => {
  host.value = 'before.local';
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('keeps new stores readable after hostname changes and serializes concurrent writes', async () => {
  const paths = await fixture();
  await Promise.all(['one', 'two'].map(id => setSecret(id, id, paths)));
  host.value = 'another-network';
  expect(await getSecret('one', paths)).toBe('one');
  expect(await getSecret('two', paths)).toBe('two');
  expect((await stat(join(paths.secretsFile, '..', '.keystore.key'))).mode & 0o777).toBe(0o600);
});

it('migrates legacy stores with an explicit old hostname, preserving a backup and retrying safely', async () => {
  const paths = await fixture();
  const salt = randomBytes(32);
  await writeFile(paths.keystoreSaltFile, salt);
  const key = pbkdf2Sync('old.local|' + userInfo().username, salt, 100_000, 32, 'sha256');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update('test-only-value'), cipher.final()]);
  const original = JSON.stringify({ version: 1, entries: {
    app: { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
  } });
  await writeFile(paths.secretsFile, original);
  await expect(migrateKeystore(paths, 'wrong.local')).rejects.toThrow();
  expect(await readFile(paths.secretsFile, 'utf8')).toBe(original);
  await migrateKeystore(paths, 'old.local');
  expect(await readFile(paths.secretsFile + '.v1.bak', 'utf8')).toBe(original);
  host.value = 'changed-again';
  expect(await getSecret('app', paths)).toBe('test-only-value');
  await migrateKeystore(paths, 'old.local');
  expect(await getSecret('app', paths)).toBe('test-only-value');
});

it('keeps ciphertext intact when the persistent key is missing or the store version is unknown', async () => {
  const paths = await fixture();
  await setSecret('app', 'test-only-value', paths);
  const ciphertext = await readFile(paths.secretsFile, 'utf8');
  await rm(join(paths.secretsFile, '..', '.keystore.key'));
  await expect(getSecret('app', paths)).rejects.toThrow('key is missing');
  await expect(setSecret('other', 'value', paths)).rejects.toThrow('key is missing');
  expect(await readFile(paths.secretsFile, 'utf8')).toBe(ciphertext);
  await writeFile(paths.secretsFile, '{"version":999,"entries":{}}');
  await expect(listSecretIds(paths)).rejects.toThrow('Unsupported');
});
