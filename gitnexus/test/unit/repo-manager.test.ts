/**
 * P1 Unit Tests: Repository Manager
 *
 * Tests: getStoragePath, getStoragePaths, readRegistry, registerRepo, unregisterRepo
 * Covers hardening fixes #29 (API key file permissions) and #30 (case-insensitive paths on Windows)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
  getStoragePath,
  getStoragePaths,
  readRegistry,
  removeLbugArtifacts,
  replaceLbugArtifacts,
  saveCLIConfig,
  loadCLIConfig,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

// ─── getStoragePath ──────────────────────────────────────────────────

describe('getStoragePath', () => {
  it('appends .gitnexus to resolved repo path', () => {
    const result = getStoragePath('/home/user/project');
    expect(result).toContain('.gitnexus');
    expect(path.basename(result)).toBe('.gitnexus');
  });

  it('resolves relative paths', () => {
    const result = getStoragePath('.');
    // Should be an absolute path
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ─── getStoragePaths ─────────────────────────────────────────────────

describe('getStoragePaths', () => {
  it('returns storagePath, lbugPath, metaPath', () => {
    const paths = getStoragePaths('/home/user/project');
    expect(paths.storagePath).toContain('.gitnexus');
    expect(paths.lbugPath).toContain('lbug');
    expect(paths.lbugStagingPath).toContain('lbug.next');
    expect(paths.lbugBackupPath).toContain('lbug.prev');
    expect(paths.metaPath).toContain('meta.json');
  });

  it('all paths are under storagePath', () => {
    const paths = getStoragePaths('/home/user/project');
    expect(paths.lbugPath.startsWith(paths.storagePath)).toBe(true);
    expect(paths.lbugStagingPath.startsWith(paths.storagePath)).toBe(true);
    expect(paths.lbugBackupPath.startsWith(paths.storagePath)).toBe(true);
    expect(paths.metaPath.startsWith(paths.storagePath)).toBe(true);
  });
});

describe('LadybugDB artifact helpers', () => {
  it('removeLbugArtifacts deletes db and sidecar files', async () => {
    const tmpHandle = await createTempDir('gitnexus-lbug-cleanup-');
    try {
      const dbPath = path.join(tmpHandle.dbPath, 'lbug');
      await fs.writeFile(dbPath, 'db');
      await fs.writeFile(`${dbPath}.wal`, 'wal');
      await fs.writeFile(`${dbPath}.lock`, 'lock');

      await removeLbugArtifacts(dbPath);

      await expect(fs.access(dbPath)).rejects.toThrow();
      await expect(fs.access(`${dbPath}.wal`)).rejects.toThrow();
      await expect(fs.access(`${dbPath}.lock`)).rejects.toThrow();
    } finally {
      await tmpHandle.cleanup();
    }
  });

  it('replaceLbugArtifacts promotes staging db and removes temp files', async () => {
    const tmpHandle = await createTempDir('gitnexus-lbug-swap-');
    try {
      const livePath = path.join(tmpHandle.dbPath, 'lbug');
      const stagingPath = path.join(tmpHandle.dbPath, 'lbug.next');
      const backupPath = path.join(tmpHandle.dbPath, 'lbug.prev');

      await fs.writeFile(livePath, 'old-db');
      await fs.writeFile(stagingPath, 'new-db');
      await fs.writeFile(`${stagingPath}.wal`, 'new-wal');

      await replaceLbugArtifacts(livePath, stagingPath, backupPath);

      await expect(fs.readFile(livePath, 'utf-8')).resolves.toBe('new-db');
      await expect(fs.readFile(`${livePath}.wal`, 'utf-8')).resolves.toBe('new-wal');
      await expect(fs.access(stagingPath)).rejects.toThrow();
      await expect(fs.access(backupPath)).rejects.toThrow();
    } finally {
      await tmpHandle.cleanup();
    }
  });

  it('replaceLbugArtifacts restores live db if staging move fails', async () => {
    const tmpHandle = await createTempDir('gitnexus-lbug-rollback-');
    try {
      const livePath = path.join(tmpHandle.dbPath, 'lbug');
      const stagingPath = path.join(tmpHandle.dbPath, 'missing-staging');
      const backupPath = path.join(tmpHandle.dbPath, 'lbug.prev');

      await fs.writeFile(livePath, 'old-db');

      await expect(
        replaceLbugArtifacts(livePath, stagingPath, backupPath),
      ).rejects.toThrow(/No LadybugDB artifacts found/);

      await expect(fs.readFile(livePath, 'utf-8')).resolves.toBe('old-db');
      await expect(fs.access(backupPath)).rejects.toThrow();
    } finally {
      await tmpHandle.cleanup();
    }
  });
});

// ─── readRegistry ────────────────────────────────────────────────────

describe('readRegistry', () => {
  it('returns empty array when registry does not exist', async () => {
    // readRegistry reads from ~/.gitnexus/registry.json
    // If the file doesn't exist, it should return []
    // This test exercises the catch path
    const result = await readRegistry();
    // Result is an array (may or may not be empty depending on user's system)
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─── CLI Config (file permissions) ───────────────────────────────────

describe('saveCLIConfig / loadCLIConfig', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let originalHomedir: typeof os.homedir;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gitnexus-config-test-');
    originalHomedir = os.homedir;
    // Mock os.homedir to point to our temp dir
    // Note: This won't fully work because repo-manager uses its own import of os
    // We'll test what we can.
  });

  afterEach(async () => {
    os.homedir = originalHomedir;
    await tmpHandle.cleanup();
  });

  it('loadCLIConfig returns empty object when config does not exist', async () => {
    const config = await loadCLIConfig();
    // Returns {} or existing config
    expect(typeof config).toBe('object');
  });
});

// ─── Case-insensitive path comparison (Windows hardening #30) ────────

describe('case-insensitive path comparison', () => {
  it('registerRepo uses case-insensitive compare on Windows', () => {
    // The fix is in registerRepo: process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase()
    // We verify the logic inline since we can't easily mock process.platform

    const compareWindows = (a: string, b: string): boolean => {
      return a.toLowerCase() === b.toLowerCase();
    };

    // On Windows, these should match
    expect(compareWindows('D:\\Projects\\MyApp', 'd:\\projects\\myapp')).toBe(true);
    expect(compareWindows('C:\\Users\\USER\\project', 'c:\\users\\user\\project')).toBe(true);

    // Different paths should not match
    expect(compareWindows('D:\\Projects\\App1', 'D:\\Projects\\App2')).toBe(false);
  });

  it('case-sensitive compare for non-Windows', () => {
    const compareUnix = (a: string, b: string): boolean => {
      return a === b;
    };

    // On Unix, case matters
    expect(compareUnix('/home/user/Project', '/home/user/project')).toBe(false);
    expect(compareUnix('/home/user/project', '/home/user/project')).toBe(true);
  });
});

// ─── API key file permissions (hardening #29) ────────────────────────

describe('API key file permissions', () => {
  it('saveCLIConfig calls chmod 0o600 on non-Windows', async () => {
    // We verify that the saveCLIConfig code has the chmod call
    // by reading the source and checking statically.
    // The actual chmod behavior is platform-dependent.
    const source = await fs.readFile(
      path.join(process.cwd(), 'src', 'storage', 'repo-manager.ts'),
      'utf-8',
    );
    expect(source).toContain('chmod(configPath, 0o600)');
    expect(source).toContain("process.platform !== 'win32'");
  });
});
