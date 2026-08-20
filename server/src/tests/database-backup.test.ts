import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {
  AutomatedDatabaseBackupService,
  BACKUP_INTERVAL_MS,
  BACKUP_RETENTION,
  assertDistinctBackupDestinations,
  backupBucketLabels,
  verifySqliteSnapshot,
} from '../core/operations/database-backup.js';

class FakeScheduler {
  calls: Array<{ callback: () => void; delayMs: number; handle: symbol }> = [];
  cleared: unknown[] = [];

  set(callback: () => void, delayMs: number): unknown {
    const handle = Symbol('timer');
    this.calls.push({ callback, delayMs, handle });
    return handle;
  }

  clear(handle: unknown): void {
    this.cleared.push(handle);
  }

  latest() {
    return this.calls.at(-1);
  }
}

interface Fixture {
  root: string;
  sourcePath: string;
  local: string;
  external: string;
  database: Database.Database;
}

const fixtures: Fixture[] = [];
let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Failure paths deliberately log at error level. Their status and cleanup
  // are asserted below; keep expected diagnostics out of a green suite.
  stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'toefl-backup-'));
  const sourcePath = path.join(root, 'source.sqlite');
  const database = new Database(sourcePath);
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE parent (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE child (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parent(id)
    );
    INSERT INTO parent (id, value) VALUES (1, 'source row');
    INSERT INTO child (id, parent_id) VALUES (1, 1);
  `);
  const result = {
    root,
    sourcePath,
    local: path.join(root, 'local'),
    external: path.join(root, 'external'),
    database,
  };
  fixtures.push(result);
  return result;
}

async function tierFiles(root: string, tier: 'daily' | 'weekly' | 'monthly'): Promise<string[]> {
  return (await readdir(path.join(root, tier))).filter((name) => name.endsWith('.sqlite')).sort();
}

afterEach(async () => {
  stderrWriteSpy.mockRestore();
  for (const item of fixtures.splice(0)) {
    if (item.database.open) item.database.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

describe('automated SQLite backup authority', () => {
  it('publishes integrity-verified, hash-identical local and external GFS copies', async () => {
    const item = await fixture();
    const scheduler = new FakeScheduler();
    const now = new Date(2026, 7, 21, 9, 30, 0);
    const service = new AutomatedDatabaseBackupService({
      database: item.database,
      localDirectory: item.local,
      externalDirectory: item.external,
      now: () => now,
      scheduler,
    });

    await service.start();

    expect(service.getStatus()).toMatchObject({
      healthy: true,
      state: 'healthy',
      lastSuccessAt: now.toISOString(),
      nextAttemptAt: new Date(now.getTime() + BACKUP_INTERVAL_MS).toISOString(),
    });
    expect(scheduler.latest()?.delayMs).toBe(BACKUP_INTERVAL_MS);

    for (const tier of ['daily', 'weekly', 'monthly'] as const) {
      const localFiles = await tierFiles(item.local, tier);
      const externalFiles = await tierFiles(item.external, tier);
      expect(localFiles).toHaveLength(1);
      expect(externalFiles).toEqual(localFiles);

      const localVerification = await verifySqliteSnapshot(path.join(item.local, tier, localFiles[0]));
      const externalVerification = await verifySqliteSnapshot(path.join(item.external, tier, externalFiles[0]));
      expect(externalVerification.sha256).toBe(localVerification.sha256);
      expect(externalVerification.size).toBe(localVerification.size);
    }

    // The snapshot remains an independent point-in-time database while the
    // live source continues to accept writes.
    item.database.prepare("INSERT INTO parent (id, value) VALUES (2, 'later row')").run();
    const dailyName = (await tierFiles(item.local, 'daily'))[0];
    const snapshot = new Database(path.join(item.local, 'daily', dailyName), {
      readonly: true,
      fileMustExist: true,
    });
    expect((snapshot.prepare('SELECT COUNT(*) AS count FROM parent').get() as { count: number }).count).toBe(1);
    snapshot.close();

    // An offline restore is byte-identical to the verified snapshot and opens
    // with the same data and integrity.
    const restored = path.join(item.root, 'restored.sqlite');
    await copyFile(path.join(item.external, 'daily', dailyName), restored);
    expect((await verifySqliteSnapshot(restored)).sha256).toBe(
      (await verifySqliteSnapshot(path.join(item.local, 'daily', dailyName))).sha256,
    );
    await service.stop();
  });

  it('skips a current verified pair and schedules only the remaining interval', async () => {
    const item = await fixture();
    let now = new Date(2026, 7, 21, 8, 0, 0);
    const initialScheduler = new FakeScheduler();
    const initial = new AutomatedDatabaseBackupService({
      database: item.database,
      localDirectory: item.local,
      externalDirectory: item.external,
      now: () => now,
      scheduler: initialScheduler,
    });
    await initial.start();
    await initial.stop();
    const firstDaily = await tierFiles(item.local, 'daily');

    now = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const restartScheduler = new FakeScheduler();
    const restarted = new AutomatedDatabaseBackupService({
      database: item.database,
      localDirectory: item.local,
      externalDirectory: item.external,
      now: () => now,
      scheduler: restartScheduler,
    });
    await restarted.start();

    expect(await tierFiles(item.local, 'daily')).toEqual(firstDaily);
    expect(restartScheduler.latest()?.delayMs).toBe(18 * 60 * 60 * 1000);
    expect(restarted.getStatus()).toMatchObject({ healthy: true, lastAttemptAt: null });
    await restarted.stop();
  });

  it('creates a startup backup when the prior pair reaches 24 hours old', async () => {
    const item = await fixture();
    let now = new Date(2026, 7, 20, 8, 0, 0);
    const first = new AutomatedDatabaseBackupService({
      database: item.database,
      localDirectory: item.local,
      externalDirectory: item.external,
      now: () => now,
      scheduler: new FakeScheduler(),
    });
    await first.start();
    await first.stop();

    now = new Date(now.getTime() + BACKUP_INTERVAL_MS);
    const second = new AutomatedDatabaseBackupService({
      database: item.database,
      localDirectory: item.local,
      externalDirectory: item.external,
      now: () => now,
      scheduler: new FakeScheduler(),
    });
    await second.start();

    expect(await tierFiles(item.local, 'daily')).toHaveLength(2);
    expect(second.getStatus().lastAttemptAt).toBe(now.toISOString());
    await second.stop();
  });

  it('enforces 7 daily, 4 weekly, and 12 monthly paired retention buckets', async () => {
    const item = await fixture();
    let now = new Date(2025, 0, 15, 12, 0, 0);
    const service = new AutomatedDatabaseBackupService({
      database: item.database,
      localDirectory: item.local,
      externalDirectory: item.external,
      now: () => now,
      scheduler: new FakeScheduler(),
    });

    for (let monthOffset = 0; monthOffset < 14; monthOffset++) {
      now = new Date(2025, monthOffset, 15, 12, 0, 0);
      await service.runNow('manual');
      if (monthOffset === 0) {
        await writeFile(path.join(item.local, 'daily', 'operator-note.txt'), 'keep me');
      }
    }

    expect(await readdir(path.join(item.local, 'daily'))).toContain('operator-note.txt');
    for (const [tier, expected] of Object.entries(BACKUP_RETENTION) as Array<
      [keyof typeof BACKUP_RETENTION, number]
    >) {
      const localFiles = await tierFiles(item.local, tier);
      const externalFiles = await tierFiles(item.external, tier);
      expect(localFiles).toHaveLength(expected);
      expect(externalFiles).toEqual(localFiles);
    }
    await service.stop();
  }, 30_000);

  it('never publishes a local-only success when the external copy fails', async () => {
    const item = await fixture();
    const service = new AutomatedDatabaseBackupService({
      database: item.database,
      localDirectory: item.local,
      externalDirectory: item.external,
      now: () => new Date(2026, 7, 21, 10, 0, 0),
      scheduler: new FakeScheduler(),
      copySnapshot: async () => {
        throw new Error('simulated external device failure');
      },
    });

    await expect(service.start()).rejects.toThrow('simulated external device failure');
    expect(service.getStatus()).toMatchObject({
      healthy: false,
      state: 'failed',
      lastError: 'Automated database backup failed. Inspect the backend log for details.',
    });
    for (const tier of ['daily', 'weekly', 'monthly'] as const) {
      expect(await tierFiles(item.local, tier)).toHaveLength(0);
      expect(await tierFiles(item.external, tier)).toHaveLength(0);
    }
    await service.stop();
  });

  it('marks a later scheduled-copy failure unhealthy while retaining the last good pair', async () => {
    const item = await fixture();
    let failCopy = false;
    let now = new Date(2026, 7, 21, 11, 0, 0);
    const service = new AutomatedDatabaseBackupService({
      database: item.database,
      localDirectory: item.local,
      externalDirectory: item.external,
      now: () => now,
      scheduler: new FakeScheduler(),
      copySnapshot: async (source, destination) => {
        if (failCopy) throw new Error('external share disconnected');
        await copyFile(source, destination);
      },
    });
    await service.start();
    const lastGood = await tierFiles(item.local, 'daily');

    failCopy = true;
    now = new Date(now.getTime() + BACKUP_INTERVAL_MS);
    expect(service.getStatus()).toMatchObject({
      healthy: false,
      state: 'failed',
      lastError: 'Automated database backup is overdue. Inspect the backend log for details.',
    });
    await expect(service.runNow('scheduled')).rejects.toThrow('external share disconnected');
    expect(service.getStatus()).toMatchObject({ healthy: false, state: 'failed' });
    expect(await tierFiles(item.local, 'daily')).toEqual(lastGood);
    expect(await tierFiles(item.external, 'daily')).toEqual(lastGood);
    await service.stop();
  });

  it('discards a corrupted recent pair and replaces it before reporting healthy', async () => {
    const item = await fixture();
    let now = new Date(2026, 7, 21, 12, 0, 0);
    const first = new AutomatedDatabaseBackupService({
      database: item.database,
      localDirectory: item.local,
      externalDirectory: item.external,
      now: () => now,
      scheduler: new FakeScheduler(),
    });
    await first.start();
    await first.stop();
    const oldName = (await tierFiles(item.external, 'daily'))[0];
    const oldMonthlyName = (await tierFiles(item.external, 'monthly'))[0];
    // The daily pair remains valid; corruption in either retained GFS copy must
    // still prevent the whole set from being reported current.
    await writeFile(path.join(item.external, 'monthly', oldMonthlyName), 'not a sqlite database');

    now = new Date(now.getTime() + 60 * 60 * 1000);
    const second = new AutomatedDatabaseBackupService({
      database: item.database,
      localDirectory: item.local,
      externalDirectory: item.external,
      now: () => now,
      scheduler: new FakeScheduler(),
    });
    await second.start();

    const localFiles = await tierFiles(item.local, 'daily');
    const externalFiles = await tierFiles(item.external, 'daily');
    expect(localFiles).toHaveLength(1);
    expect(externalFiles).toEqual(localFiles);
    expect(localFiles[0]).not.toBe(oldName);
    expect(second.getStatus()).toMatchObject({ healthy: true, lastAttemptAt: now.toISOString() });
    await second.stop();
  });
});

describe('backup configuration and bucket boundaries', () => {
  it('requires a real external destination distinct from local storage', () => {
    expect(() => assertDistinctBackupDestinations('/data/local', '')).toThrow('BACKUP_EXTERNAL_DIR');
    expect(() =>
      assertDistinctBackupDestinations('/data/local', 'REQUIRED_EXTERNAL_DRIVE_OR_NETWORK_PATH'),
    ).toThrow('BACKUP_EXTERNAL_DIR');
    expect(() => assertDistinctBackupDestinations('/data/local', '/data/local')).toThrow('different');
  });

  it('on Windows requires a local primary directory plus another drive or a UNC share', () => {
    expect(() =>
      assertDistinctBackupDestinations('\\\\server\\local', 'E:\\ERP\\external', 'win32'),
    ).toThrow('local Windows directory');
    expect(() =>
      assertDistinctBackupDestinations('C:\\ERP\\local', 'C:\\ERP\\external', 'win32'),
    ).toThrow('another Windows drive');
    expect(() =>
      assertDistinctBackupDestinations('C:\\ERP\\local', 'E:\\ERP\\external', 'win32'),
    ).not.toThrow();
    expect(() =>
      assertDistinctBackupDestinations('C:\\ERP\\local', '\\\\backup-pc\\share', 'win32'),
    ).not.toThrow();
  });

  it('first-install bootstrap requires an external path and preserves Windows path bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'toefl-env-bootstrap-'));
    try {
      const serverDirectory = path.join(root, 'server');
      const scriptsDirectory = path.join(serverDirectory, 'scripts');
      await mkdir(scriptsDirectory, { recursive: true });
      const repositoryServer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
      const script = path.join(scriptsDirectory, 'ensure-first-install-env.mjs');
      await copyFile(path.join(repositoryServer, 'scripts', 'ensure-first-install-env.mjs'), script);
      await copyFile(path.join(repositoryServer, '.env.example'), path.join(serverDirectory, '.env.example'));

      const first = spawnSync(process.execPath, [script], { encoding: 'utf8' });
      expect(first.status).toBe(2);
      expect(first.stderr).toContain('[ACTION REQUIRED]');

      const envPath = path.join(serverDirectory, '.env');
      const configuredPath = String.raw`E:\$Archive\TOEFL-House-Backups`;
      const configured = (await readFile(envPath, 'utf8')).replace(
        'BACKUP_EXTERNAL_DIR=REQUIRED_EXTERNAL_DRIVE_OR_NETWORK_PATH',
        `BACKUP_EXTERNAL_DIR=${configuredPath}`,
      );
      await writeFile(envPath, configured);

      const second = spawnSync(process.execPath, [script], { encoding: 'utf8' });
      expect(second.status).toBe(0);
      const externalLine = (await readFile(envPath, 'utf8'))
        .split(/\r?\n/)
        .find((line) => line.startsWith('BACKUP_EXTERNAL_DIR='));
      expect(externalLine).toBe(`BACKUP_EXTERNAL_DIR=${configuredPath}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses machine-local calendar days, ISO weeks, and months for GFS labels', () => {
    expect(backupBucketLabels(new Date(2026, 11, 31, 23, 30, 0))).toEqual({
      daily: '2026-12-31',
      weekly: '2026-W53',
      monthly: '2026-12',
    });
    expect(backupBucketLabels(new Date(2027, 0, 1, 0, 30, 0))).toEqual({
      daily: '2027-01-01',
      weekly: '2026-W53',
      monthly: '2027-01',
    });
  });
});
