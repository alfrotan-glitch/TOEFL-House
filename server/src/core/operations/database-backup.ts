import type BetterSqlite3 from 'better-sqlite3';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../observability/logger.js';

const log = createLogger('database-backup');

export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const BACKUP_RETENTION = {
  daily: 7,
  weekly: 4,
  monthly: 12,
} as const;

export type BackupTier = keyof typeof BACKUP_RETENTION;
export type BackupReason = 'startup' | 'scheduled' | 'manual';
export type BackupState = 'idle' | 'checking' | 'running' | 'healthy' | 'failed' | 'stopped';

export interface BackupStatus {
  healthy: boolean;
  state: BackupState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
}

export interface BackupRunResult {
  reason: BackupReason;
  createdAt: string;
  files: Record<BackupTier, string>;
  sha256: string;
}

interface TimerScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

interface BackupServiceOptions {
  database: BetterSqlite3.Database;
  localDirectory: string;
  externalDirectory: string;
  now?: () => Date;
  scheduler?: TimerScheduler;
  copySnapshot?: (source: string, destination: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

interface ManagedSnapshot {
  name: string;
  tier: BackupTier;
  label: string;
  timestampKey: string;
  runId: string;
  createdAtMs: number;
}

interface VerifiedSnapshot {
  path: string;
  sha256: string;
  size: number;
}

const TIERS = Object.keys(BACKUP_RETENTION) as BackupTier[];
const MANAGED_SNAPSHOT = /^(daily|weekly|monthly)__([A-Za-z0-9-]+)__(\d{8}T\d{9}Z)__([a-f0-9-]+)\.sqlite$/;
const EXTERNAL_PLACEHOLDER = /(?:required|replace|change).*(?:external|backup)|(?:external|backup).*(?:required|replace|change)/i;

const defaultScheduler: TimerScheduler = {
  set(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

function parseCompactTimestamp(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(value);
  if (!match) return Number.NaN;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  );
}

function isoWeekLabel(date: Date): string {
  // Convert the machine-local calendar day to an isolated UTC day before ISO
  // week arithmetic. Operational buckets therefore follow the Windows PC's
  // calendar without daylight-saving offsets changing the week calculation.
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const weekYear = day.getUTCFullYear();
  const first = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil((((day.getTime() - first.getTime()) / 86_400_000) + 1) / 7);
  return `${weekYear}-W${pad(week)}`;
}

export function backupBucketLabels(date: Date): Record<BackupTier, string> {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return {
    daily: `${year}-${month}-${day}`,
    weekly: isoWeekLabel(date),
    monthly: `${year}-${month}`,
  };
}

function parseManagedSnapshot(name: string): ManagedSnapshot | null {
  const match = MANAGED_SNAPSHOT.exec(name);
  if (!match) return null;
  const createdAtMs = parseCompactTimestamp(match[3]);
  if (!Number.isFinite(createdAtMs)) return null;
  return {
    name,
    tier: match[1] as BackupTier,
    label: match[2],
    timestampKey: match[3],
    runId: match[4],
    createdAtMs,
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Opens the snapshot itself and proves both SQLite and referential integrity. */
export async function verifySqliteSnapshot(filePath: string): Promise<VerifiedSnapshot> {
  const snapshot = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = snapshot.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') {
      throw new Error(`SQLite integrity_check failed for a backup snapshot: ${integrity}`);
    }
    const foreignKeyViolations = snapshot.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error(`SQLite foreign_key_check found ${foreignKeyViolations.length} backup violation(s).`);
    }
  } finally {
    snapshot.close();
  }

  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error('Backup snapshot is not a non-empty regular file.');
  }
  return { path: filePath, size: fileStat.size, sha256: await sha256File(filePath) };
}

async function removeIfPresent(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => undefined);
}

async function assertWritable(directory: string): Promise<void> {
  const probe = path.join(directory, `.backup-write-probe-${randomUUID()}.tmp`);
  const handle = await open(probe, 'wx');
  try {
    await handle.writeFile('TOEFL House backup destination probe');
    await handle.sync();
  } finally {
    await handle.close();
    await removeIfPresent(probe);
  }
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Rejects configuration that can only produce two names for the same local
 * destination. On Windows, an external destination must be a UNC path or use a
 * different drive from the local snapshots.
 */
export function assertDistinctBackupDestinations(
  localDirectory: string,
  externalDirectory: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const external = externalDirectory.trim();
  if (!external || EXTERNAL_PLACEHOLDER.test(external)) {
    throw new Error('BACKUP_EXTERNAL_DIR must name a configured external drive or network share.');
  }

  const pathApi = platform === 'win32' ? path.win32 : path;
  const localResolved = pathApi.resolve(localDirectory);
  const externalResolved = pathApi.resolve(external);
  if (pathKey(localResolved, platform) === pathKey(externalResolved, platform)) {
    throw new Error('Local and external backup destinations must be different directories.');
  }

  if (platform === 'win32') {
    if (localResolved.startsWith('\\\\')) {
      throw new Error('BACKUP_LOCAL_DIR must be a local Windows directory, not a network share.');
    }
    const isUnc = externalResolved.startsWith('\\\\');
    const localRoot = path.win32.parse(localResolved).root.toLowerCase();
    const externalRoot = path.win32.parse(externalResolved).root.toLowerCase();
    if (!isUnc && localRoot === externalRoot) {
      throw new Error('BACKUP_EXTERNAL_DIR must use another Windows drive or a UNC network path.');
    }
  }
}

export class AutomatedDatabaseBackupService {
  private readonly database: BetterSqlite3.Database;
  private readonly localDirectory: string;
  private readonly externalDirectory: string;
  private readonly externalConfiguration: string;
  private readonly now: () => Date;
  private readonly scheduler: TimerScheduler;
  private readonly copySnapshot: (source: string, destination: string) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  private timer: unknown = null;
  private started = false;
  private activeRun: Promise<BackupRunResult> | null = null;
  private status: BackupStatus = {
    healthy: false,
    state: 'idle',
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
    lastError: null,
  };

  constructor(options: BackupServiceOptions) {
    this.database = options.database;
    this.localDirectory = path.resolve(options.localDirectory);
    this.externalConfiguration = options.externalDirectory;
    this.externalDirectory = options.externalDirectory.trim()
      ? path.resolve(options.externalDirectory)
      : '';
    this.now = options.now ?? (() => new Date());
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.copySnapshot = options.copySnapshot ?? copyFile;
    this.platform = options.platform ?? process.platform;
  }

  getStatus(): BackupStatus {
    const reported = { ...this.status };
    if (
      reported.healthy
      && reported.state === 'healthy'
      && reported.lastSuccessAt
      && this.now().getTime() - new Date(reported.lastSuccessAt).getTime() >= BACKUP_INTERVAL_MS
    ) {
      return {
        ...reported,
        healthy: false,
        state: 'failed',
        lastError: 'Automated database backup is overdue. Inspect the backend log for details.',
      };
    }
    return reported;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.status = { ...this.status, state: 'checking', lastError: null };

    try {
      await this.prepareDestinations();
      await this.applyRetention();
      const current = await this.findCurrentVerifiedPair();
      if (current) {
        const createdAt = new Date(current.createdAtMs);
        this.status = {
          healthy: true,
          state: 'healthy',
          lastAttemptAt: null,
          lastSuccessAt: createdAt.toISOString(),
          nextAttemptAt: null,
          lastError: null,
        };
        this.schedule(Math.max(0, createdAt.getTime() + BACKUP_INTERVAL_MS - this.now().getTime()));
        log.info('Verified current local and external database backup pair.');
        return;
      }

      await this.runNow('startup');
      this.scheduleFromLastAttempt();
    } catch (error) {
      this.started = false;
      if (this.status.state !== 'failed') this.markFailure(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      this.scheduler.clear(this.timer);
      this.timer = null;
    }
    this.started = false;
    const activeRun = this.activeRun;
    if (activeRun) {
      try {
        await activeRun;
      } catch {
        // The run already recorded its failure; shutdown only waits for its
        // SQLite handle and temporary-file work to finish before db.close().
      }
    }
    this.status = { ...this.status, healthy: false, state: 'stopped', nextAttemptAt: null };
  }

  runNow(reason: BackupReason = 'manual'): Promise<BackupRunResult> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.createVerifiedBackupSet(reason).finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  private async prepareDestinations(): Promise<void> {
    assertDistinctBackupDestinations(
      this.localDirectory,
      this.externalConfiguration,
      this.platform,
    );
    await mkdir(this.localDirectory, { recursive: true });
    await mkdir(this.externalDirectory, { recursive: true });

    const [localReal, externalReal] = await Promise.all([
      realpath(this.localDirectory),
      realpath(this.externalDirectory),
    ]);
    if (pathKey(localReal, this.platform) === pathKey(externalReal, this.platform)) {
      throw new Error('Local and external backup destinations resolve to the same directory.');
    }

    for (const tier of TIERS) {
      await mkdir(this.tierDirectory(this.localDirectory, tier), { recursive: true });
      await mkdir(this.tierDirectory(this.externalDirectory, tier), { recursive: true });
    }
    await assertWritable(this.localDirectory);
    await assertWritable(this.externalDirectory);
  }

  private tierDirectory(root: string, tier: BackupTier): string {
    return path.join(root, tier);
  }

  private managedName(tier: BackupTier, label: string, date: Date, runId: string): string {
    return `${tier}__${label}__${compactTimestamp(date)}__${runId}.sqlite`;
  }

  private async createVerifiedBackupSet(reason: BackupReason): Promise<BackupRunResult> {
    const attemptedAt = this.now();
    this.status = {
      ...this.status,
      healthy: false,
      state: 'running',
      lastAttemptAt: attemptedAt.toISOString(),
      nextAttemptAt: null,
      lastError: null,
    };

    const runId = randomUUID();
    const labels = backupBucketLabels(attemptedAt);
    const temporaryPaths: string[] = [];
    const finalPaths: string[] = [];
    const files = {} as Record<BackupTier, string>;
    let publicationComplete = false;

    try {
      await this.prepareDestinations();
      const localTemps = {} as Record<BackupTier, string>;
      const externalTemps = {} as Record<BackupTier, string>;
      const localFinals = {} as Record<BackupTier, string>;
      const externalFinals = {} as Record<BackupTier, string>;

      for (const tier of TIERS) {
        const name = this.managedName(tier, labels[tier], attemptedAt, runId);
        localFinals[tier] = path.join(this.tierDirectory(this.localDirectory, tier), name);
        externalFinals[tier] = path.join(this.tierDirectory(this.externalDirectory, tier), name);
        localTemps[tier] = `${localFinals[tier]}.tmp-${runId}`;
        externalTemps[tier] = `${externalFinals[tier]}.tmp-${runId}`;
        temporaryPaths.push(localTemps[tier], externalTemps[tier]);
        finalPaths.push(localFinals[tier], externalFinals[tier]);
        files[tier] = name;
      }

      // better-sqlite3 delegates to SQLite's online backup API. This is a
      // transaction-consistent database snapshot, never a raw copy of the live
      // database file or its WAL sidecars.
      await this.database.backup(localTemps.daily);
      await syncFile(localTemps.daily);
      const sourceVerification = await verifySqliteSnapshot(localTemps.daily);

      for (const tier of TIERS) {
        if (tier !== 'daily') {
          await this.copySnapshot(localTemps.daily, localTemps[tier]);
          await syncFile(localTemps[tier]);
        }
        const localVerification = tier === 'daily'
          ? sourceVerification
          : await verifySqliteSnapshot(localTemps[tier]);
        if (localVerification.sha256 !== sourceVerification.sha256) {
          throw new Error(`Local ${tier} backup does not match the SQLite snapshot.`);
        }

        await this.copySnapshot(localTemps[tier], externalTemps[tier]);
        await syncFile(externalTemps[tier]);
        const externalVerification = await verifySqliteSnapshot(externalTemps[tier]);
        if (
          externalVerification.sha256 !== sourceVerification.sha256
          || externalVerification.size !== sourceVerification.size
        ) {
          throw new Error(`External ${tier} backup does not match the verified local snapshot.`);
        }
      }

      // Every copy has passed SQLite integrity and SHA-256 comparison before a
      // managed final name becomes visible to startup discovery.
      for (const tier of TIERS) {
        await rename(localTemps[tier], localFinals[tier]);
        await rename(externalTemps[tier], externalFinals[tier]);
      }
      publicationComplete = true;
      await this.applyRetention();

      const completedAt = this.now();
      this.status = {
        healthy: true,
        state: 'healthy',
        lastAttemptAt: attemptedAt.toISOString(),
        lastSuccessAt: attemptedAt.toISOString(),
        nextAttemptAt: null,
        lastError: null,
      };
      log.info('Verified local and external database backups.', {
        reason,
        createdAt: attemptedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        sha256: sourceVerification.sha256,
      });
      return {
        reason,
        createdAt: attemptedAt.toISOString(),
        files,
        sha256: sourceVerification.sha256,
      };
    } catch (error) {
      await Promise.all(temporaryPaths.map(removeIfPresent));
      if (!publicationComplete) {
        await Promise.all(finalPaths.map(removeIfPresent));
      }
      this.markFailure(error);
      throw error;
    }
  }

  private markFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.status = {
      ...this.status,
      healthy: false,
      state: 'failed',
      nextAttemptAt: null,
      lastError: 'Automated database backup failed. Inspect the backend log for details.',
    };
    log.error('Automated database backup failed.', error, { backupError: message });
  }

  private async findCurrentVerifiedPair(): Promise<ManagedSnapshot | null> {
    const localDaily = this.tierDirectory(this.localDirectory, 'daily');
    const externalDaily = this.tierDirectory(this.externalDirectory, 'daily');
    const [localNames, externalNames] = await Promise.all([readdir(localDaily), readdir(externalDaily)]);
    const externalSet = new Set(externalNames);
    const nowMs = this.now().getTime();
    const candidates = localNames
      .map(parseManagedSnapshot)
      .filter((entry): entry is ManagedSnapshot => entry?.tier === 'daily' && externalSet.has(entry.name))
      .filter((entry) => entry.createdAtMs <= nowMs && nowMs - entry.createdAtMs < BACKUP_INTERVAL_MS)
      .sort((a, b) => b.createdAtMs - a.createdAtMs);

    for (const candidate of candidates) {
      const labels = backupBucketLabels(new Date(candidate.createdAtMs));
      const expected = TIERS.map((tier) => {
        const name = `${tier}__${labels[tier]}__${candidate.timestampKey}__${candidate.runId}.sqlite`;
        return {
          name,
          localPath: path.join(this.tierDirectory(this.localDirectory, tier), name),
          externalPath: path.join(this.tierDirectory(this.externalDirectory, tier), name),
        };
      });
      try {
        const verifications = await Promise.all(
          expected.flatMap((entry) => [
            verifySqliteSnapshot(entry.localPath),
            verifySqliteSnapshot(entry.externalPath),
          ]),
        );
        const baseline = verifications[0];
        if (verifications.every(
          (verification) =>
            verification.sha256 === baseline.sha256 && verification.size === baseline.size,
        )) {
          return candidate;
        }
        throw new Error('Current GFS backup copies do not have identical hashes and sizes.');
      } catch (error) {
        log.error('Discarding an invalid current GFS backup set.', error, {
          backup: candidate.name,
        });
        await Promise.all(
          expected.flatMap((entry) => [
            rm(entry.localPath, { force: true }),
            rm(entry.externalPath, { force: true }),
          ]),
        );
      }
    }
    return null;
  }

  private async applyRetention(): Promise<void> {
    for (const tier of TIERS) {
      await this.pruneTier(tier, BACKUP_RETENTION[tier]);
    }
  }

  private async pruneTier(tier: BackupTier, limit: number): Promise<void> {
    const localDirectory = this.tierDirectory(this.localDirectory, tier);
    const externalDirectory = this.tierDirectory(this.externalDirectory, tier);
    const [localNames, externalNames] = await Promise.all([
      readdir(localDirectory),
      readdir(externalDirectory),
    ]);
    const localManaged = new Set(
      localNames.filter((name) => parseManagedSnapshot(name)?.tier === tier),
    );
    const externalManaged = new Set(
      externalNames.filter((name) => parseManagedSnapshot(name)?.tier === tier),
    );
    const paired = [...localManaged]
      .filter((name) => externalManaged.has(name))
      .map(parseManagedSnapshot)
      .filter((entry): entry is ManagedSnapshot => entry !== null)
      .sort((a, b) => b.timestampKey.localeCompare(a.timestampKey));

    const newestByBucket = new Map<string, ManagedSnapshot>();
    for (const entry of paired) {
      if (!newestByBucket.has(entry.label)) newestByBucket.set(entry.label, entry);
    }
    const retainedBuckets = [...newestByBucket.keys()].sort().reverse().slice(0, limit);
    const keep = new Set(retainedBuckets.map((label) => newestByBucket.get(label)!.name));
    const allManaged = new Set([...localManaged, ...externalManaged]);

    for (const name of allManaged) {
      if (keep.has(name)) continue;
      await Promise.all([
        rm(path.join(localDirectory, name), { force: true }),
        rm(path.join(externalDirectory, name), { force: true }),
      ]);
    }
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    if (this.timer !== null) this.scheduler.clear(this.timer);
    const safeDelay = Math.max(0, delayMs);
    this.status = {
      ...this.status,
      nextAttemptAt: new Date(this.now().getTime() + safeDelay).toISOString(),
    };
    this.timer = this.scheduler.set(() => {
      this.timer = null;
      void this.runScheduledAttempt();
    }, safeDelay);
  }

  private scheduleFromLastAttempt(): void {
    const anchor = this.status.lastAttemptAt
      ? new Date(this.status.lastAttemptAt).getTime()
      : this.now().getTime();
    this.schedule(Math.max(0, anchor + BACKUP_INTERVAL_MS - this.now().getTime()));
  }

  private async runScheduledAttempt(): Promise<void> {
    try {
      await this.runNow('scheduled');
    } catch {
      // runNow records and logs the failure. The service remains alive so the
      // next required 24-hour attempt can recover without a process restart.
    } finally {
      if (this.started) this.scheduleFromLastAttempt();
    }
  }
}

export function createAutomatedDatabaseBackupService(
  database: BetterSqlite3.Database,
  env: NodeJS.ProcessEnv = process.env,
): AutomatedDatabaseBackupService {
  const localDirectory = env.BACKUP_LOCAL_DIR?.trim() || './data/backups';
  const externalDirectory = env.BACKUP_EXTERNAL_DIR?.trim() || '';
  return new AutomatedDatabaseBackupService({ database, localDirectory, externalDirectory });
}
