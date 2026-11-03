import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createRecoveryPoint, RECOVERY_DATABASE, restoreRecoveryPoint, type RecoveryManifest } from '../src/app/backup.ts'
import { Store, SCHEMA_VERSION } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'

let directory: string, store: Store, databasePath: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'backup-test-'))
  databasePath = join(directory, RECOVERY_DATABASE)
  store = new Store(databasePath)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const snapshot = (roots = {}) => createRecoveryPoint(store, { databasePath, destination: join(directory, 'backup'), roots })
function rewrite(manifest: RecoveryManifest) { writeFileSync(join(directory, 'backup', 'manifest.json'), JSON.stringify(manifest)) }

it('restores committed WAL data under the runtime database name and maps individual files and directories', () => {
  const workspace = join(directory, 'workspace'), attachment = join(directory, 'attachment.txt')
  mkdirSync(workspace); mkdirSync(join(workspace, 'empty')); writeFileSync(join(workspace, 'note.txt'), 'workspace'); writeFileSync(attachment, 'attachment')
  store.set(KV.runtime.masterId, 'persisted-master')
  const manifest = snapshot({ workspaces: [workspace], attachments: [attachment] })
  expect(manifest.schemaVersion).toBe(SCHEMA_VERSION)
  expect(manifest.files).toHaveLength(3)
  expect(manifest.mappings.map(mapping => mapping.kind)).toEqual(['directory', 'file'])
  const destination = join(directory, 'restored')
  const restored = restoreRecoveryPoint(join(directory, 'backup'), destination)
  const reopened = new Store(join(destination, RECOVERY_DATABASE))
  try { expect(reopened.get(KV.runtime.masterId)).toBe('persisted-master') } finally { reopened.close() }
  expect(readFileSync(join(destination, manifest.mappings[1]!.path), 'utf8')).toBe('attachment')
  expect(existsSync(join(destination, manifest.mappings[0]!.path, 'empty'))).toBe(true)
  expect(restored.restoredProfile).toEqual({ execution: 'prohibited', model: 'prohibited', outbound: 'prohibited', isolatedRoot: destination })
  expect(JSON.parse(readFileSync(join(destination, 'restore-profile.json'), 'utf8'))).toMatchObject({ execution: false, model: false, outbound: false })
})

it('excludes credential files and explicit credential directories without following symlinks', () => {
  const root = join(directory, 'workspace'), accounts = join(root, 'accounts')
  mkdirSync(accounts, { recursive: true }); writeFileSync(join(accounts, 'opaque.json'), 'secret')
  writeFileSync(join(root, '.env'), 'TOKEN=secret'); writeFileSync(join(root, '.git-credentials'), 'secret'); writeFileSync(join(root, '.credentials.yaml'), 'native-secret-store'); writeFileSync(join(root, 'safe.txt'), 'safe')
  const manifest = createRecoveryPoint(store, { databasePath, destination: join(directory, 'backup'), roots: { workspaces: [root] }, credentialPaths: [accounts] })
  expect(manifest.excluded).toHaveLength(4)
  expect(manifest.files.map(file => file.path.split('/').pop())).toEqual([RECOVERY_DATABASE, 'safe.txt'])
  expect(existsSync(join(directory, 'backup', 'INCOMPLETE'))).toBe(false)
})

it('marks missing roots and unsupported symbolic links incomplete and refuses to restore them', () => {
  const root = join(directory, 'workspace'); mkdirSync(root)
  symlinkSync(databasePath, join(root, 'linked-database'))
  const missing = join(directory, 'missing')
  const manifest = snapshot({ workspaces: [root, missing] })
  expect(manifest.missing).toEqual([missing]); expect(manifest.incomplete).toEqual([join(root, 'linked-database')])
  expect(existsSync(join(directory, 'backup', 'INCOMPLETE'))).toBe(true)
  expect(() => restoreRecoveryPoint(join(directory, 'backup'), join(directory, 'restore'))).toThrow('incomplete')
  expect(existsSync(join(directory, 'restore'))).toBe(false)
})

it('rejects tampered contents, database hashes, missing database entries and traversal paths before writing', () => {
  const manifest = snapshot(), source = join(directory, 'backup'), target = join(directory, 'restore')
  rewrite({ ...manifest, schemaVersion: 999 })
  expect(() => restoreRecoveryPoint(source, target)).toThrow('incomplete')
  rewrite({ ...manifest, database: { ...manifest.database, sha256: '0'.repeat(64) } })
  expect(() => restoreRecoveryPoint(source, target)).toThrow('matching file hash')
  rewrite({ ...manifest, files: [] })
  expect(() => restoreRecoveryPoint(source, target)).toThrow('matching file hash')
  rewrite({ ...manifest, files: [{ ...manifest.files[0]!, path: '../orchestrator.sqlite' }] })
  expect(() => restoreRecoveryPoint(source, target)).toThrow('Unsafe recovery path')
  rewrite(manifest); writeFileSync(join(source, RECOVERY_DATABASE), 'corrupted')
  expect(() => restoreRecoveryPoint(source, target)).toThrow('hash mismatch')
  expect(existsSync(target)).toBe(false)
})

it('copies only hashed files and rejects symbolic links substituted into the backup', () => {
  const root = join(directory, 'workspace'); mkdirSync(root); writeFileSync(join(root, 'note.txt'), 'safe')
  const manifest = snapshot({ workspaces: [root] }), source = join(directory, 'backup')
  writeFileSync(join(source, manifest.mappings[0]!.path, 'extra-secret.txt'), 'unlisted')
  const target = join(directory, 'restored'); restoreRecoveryPoint(source, target)
  expect(existsSync(join(target, manifest.mappings[0]!.path, 'extra-secret.txt'))).toBe(false)
  const copiedFile = join(source, manifest.files[1]!.path)
  rmSync(copiedFile); symlinkSync(join(root, 'note.txt'), copiedFile)
  expect(() => restoreRecoveryPoint(source, join(directory, 'other'))).toThrow('symbolic link')
})

it('refuses existing destinations, mismatched Store paths and destinations nested in declared roots', () => {
  expect(() => createRecoveryPoint(store, { databasePath: join(directory, 'missing.sqlite'), destination: join(directory, 'backup') })).toThrow()
  const root = join(directory, 'workspace'); mkdirSync(root)
  expect(() => createRecoveryPoint(store, { databasePath, destination: join(root, 'backup'), roots: { workspaces: [root] } })).toThrow('separate')
  const alias = join(directory, 'workspace-alias'); symlinkSync(root, alias)
  expect(() => createRecoveryPoint(store, { databasePath, destination: join(alias, 'backup'), roots: { workspaces: [root] } })).toThrow('separate')
  snapshot()
  expect(() => snapshot()).toThrow('must not exist')
  expect(() => restoreRecoveryPoint(join(directory, 'backup'), root)).toThrow('must not exist')
})
