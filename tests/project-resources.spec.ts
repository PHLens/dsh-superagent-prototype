/** Real filesystem/SQLite boundaries, including changes during an open read. */
import { afterEach, expect, it, vi } from 'vitest'
import { chmodSync, fstatSync, mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Projects } from '../src/core/projects.ts'
import { ProjectResources, type Resource } from '../src/app/project-resources.ts'

const io = vi.hoisted(() => ({
  onOpen: undefined as ((path: unknown, open: () => number) => number) | undefined,
  beforeRead: undefined as (() => void) | undefined,
  bytes: 0, opens: 0, lastFd: undefined as number | undefined,
}))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual,
    openSync: (...args: unknown[]) => {
      io.opens++
      const open = () => Reflect.apply(actual.openSync, actual, args) as number
      const fd = io.onOpen ? io.onOpen(args[0], open) : open()
      io.lastFd = fd
      return fd
    },
    readSync: (...args: unknown[]) => {
      io.beforeRead?.()
      const count = Reflect.apply(actual.readSync, actual, args) as number
      io.bytes += count
      return count
    },
  }
})
const cleanup: (() => void)[] = []
afterEach(() => {
  io.onOpen = undefined; io.beforeRead = undefined; io.bytes = 0; io.opens = 0; io.lastFd = undefined
  for (const close of cleanup.splice(0)) close()
})
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 't7-resource-'))), root = join(dir, 'linked'), outside = join(dir, 'outside')
  mkdirSync(root); mkdirSync(outside)
  const store = new Store(join(dir, 'db')), projects = new Projects({ repo: store })
  const a = projects.create({ name: 'A', goal: 'Registered local materials' }), b = projects.create({ name: 'B', goal: 'Independent materials' })
  let now = Date.now()
  const resources = new ProjectResources(store, () => now, 60_000)
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const register = (path = root, type: Resource['type'] = 'directory', maxBytes = 1024) => resources.register({ projectId: a.id, type, path, purpose: 'Explicit local grant', maxBytes })
  return { dir, root, outside, store, a, b, resources, register, advance: (ms: number) => { now += ms } }
}

it('pages a grant to its exact version, rejects a stale or foreign page, and captures content at admission', () => {
  const f = fixture()
  writeFileSync(join(f.root, 'b.md'), 'two'); writeFileSync(join(f.root, 'a.md'), 'one')
  const resource = f.register(), first = f.resources.browse(f.a.id, resource.id, '', undefined, 0, 1)
  expect(first).toMatchObject({ offset: 0, total: 2, next_offset: 1 })
  expect(first.entries.map(e => e.name)).toEqual(['a.md'])
  expect(f.resources.browse(f.a.id, resource.id, '', first, 1, 1)).toMatchObject({ next_offset: null })
  expect(() => f.resources.browse(f.a.id, resource.id, '', undefined, 1, 1)).toThrow('snapshot')
  expect(() => f.resources.browse(f.b.id, resource.id, '', first)).toThrow('Unknown')
  mkdirSync(join(f.root, 'child'))
  expect(() => f.resources.browse(f.a.id, resource.id, 'child', first)).toThrow('stale')
  writeFileSync(join(f.root, 'a.md'), 'changed')
  expect(() => f.resources.browse(f.a.id, resource.id, '', first)).toThrow('stale')
  const fresh = f.resources.browse(f.a.id, resource.id); f.advance(60_000)
  expect(() => f.resources.browse(f.a.id, resource.id, '', fresh)).toThrow('stale')
  // Admission capture pins a content manifest, so registration metadata alone never authorizes bytes.
  const captured = f.resources.capture(f.a.id, resource.id)
  expect(f.resources.assertCurrent(f.a.id, resource.id).version).toBe(captured.version)
  writeFileSync(join(f.root, 'a.md'), 'changed again')
  expect(() => f.resources.assertCurrent(f.a.id, resource.id)).toThrow('stale')
})

it('reads exact-version bytes, preserves binary content and bounds text previews', () => {
  const f = fixture(), file = join(f.root, 'a.md'), stamp = new Date('2025-01-01T00:00:00Z')
  writeFileSync(file, 'one'); utimesSync(file, stamp, stamp)
  const resource = f.register(file, 'file'), version = f.resources.browse(f.a.id, resource.id).entries[0]!.version
  expect(f.resources.preview(f.a.id, resource.id, '', version).content).toBe('one')
  writeFileSync(file, 'two'); utimesSync(file, stamp, stamp)
  expect(() => f.resources.preview(f.a.id, resource.id, '', version)).toThrow('version')
  const binary = Buffer.from([0xc3, 0x28, 0xff]), bin = join(f.root, 'sample.bin')
  writeFileSync(bin, binary)
  const attachment = f.register(bin, 'attachment')
  expect(f.resources.download(f.a.id, attachment.id, '')).toEqual(binary)
  expect(() => f.resources.preview(f.a.id, attachment.id, '')).toThrow('Binary')
  const long = join(f.root, 'long.md'); writeFileSync(long, 'a'.repeat(15_999) + '🙂' + 'tail')
  const view = f.resources.preview(f.a.id, f.register(long, 'file', 100_000).id, '')
  expect(view).toEqual({ content: 'a'.repeat(15_999), truncated: true })
})

it('rejects traversal, symlinks, permission changes and revocation before returning names or bytes', () => {
  const f = fixture(); writeFileSync(join(f.outside, 'outside-secret.md'), 'outside')
  symlinkSync(f.outside, join(f.root, 'jump'), 'dir')
  const resource = f.register()
  expect(() => f.resources.browse(f.a.id, resource.id, 'jump')).toThrow()
  expect(() => f.resources.preview(f.a.id, resource.id, '../outside/outside-secret.md')).toThrow()
  expect(f.resources.browse(f.a.id, resource.id).entries).toEqual([])
  const child = join(f.root, 'child'), file = join(child, 'a.md')
  mkdirSync(child); writeFileSync(file, 'one')
  const page = f.resources.browse(f.a.id, resource.id, 'child')
  expect(f.resources.preview(f.a.id, resource.id, 'child/a.md').content).toBe('one')
  try {
    chmodSync(file, 0o000); expect(() => f.resources.download(f.a.id, resource.id, 'child/a.md')).toThrow()
    chmodSync(file, 0o644); chmodSync(child, 0o000)
    expect(() => f.resources.download(f.a.id, resource.id, 'child/a.md')).toThrow()
  } finally { chmodSync(child, 0o755); chmodSync(file, 0o644) }
  f.resources.revoke(f.a.id, resource.id)
  expect(() => f.resources.preview(f.a.id, resource.id, 'child/a.md')).toThrow('revoked')
  expect(() => f.resources.browse(f.a.id, resource.id, 'child', page)).toThrow('revoked')
  expect(() => f.register(file, 'directory')).toThrow('type')
  expect(() => f.register(f.root, 'file')).toThrow('type')
  expect(() => f.register(file, 'file', 0)).toThrow('Invalid')
  expect(() => f.register(file, 'file', 16_000_001)).toThrow('Invalid')
})

it('bounds bytes read and returns nothing when the grant or the path changes mid-read', () => {
  const f = fixture(), file = join(f.root, 'a.md'); writeFileSync(file, 'oversized')
  const small = f.register(file, 'file', 3)
  io.opens = 0; io.bytes = 0
  expect(() => f.resources.download(f.b.id, small.id, '')).toThrow('Unknown')
  expect(io.opens).toBe(0)
  expect(() => f.resources.download(f.a.id, small.id, '')).toThrow('large')
  expect(io.bytes).toBe(0)
  const resource = f.register(file, 'file', 64)
  io.beforeRead = () => { io.beforeRead = undefined; writeFileSync(file, Buffer.alloc(32_000, 65)) }
  expect(() => f.resources.download(f.a.id, resource.id, '')).toThrow('changed')
  expect(io.bytes).toBeLessThanOrEqual(resource.maxBytes + 1)
  expect(() => fstatSync(io.lastFd!)).toThrow()
  const parent = join(f.root, 'raced'), saved = join(f.root, 'saved'); mkdirSync(parent)
  const inside = join(parent, 'a.md'); writeFileSync(inside, 'inside'); writeFileSync(join(f.outside, 'a.md'), 'secret')
  const raced = f.register()
  io.bytes = 0
  io.onOpen = (path, open) => {
    if (path !== inside) return open()
    renameSync(parent, saved); symlinkSync(f.outside, parent, 'dir')
    try { return open() } finally { unlinkSync(parent); renameSync(saved, parent) }
  }
  let returned: string | undefined, error: string | undefined
  try { returned = f.resources.download(f.a.id, raced.id, 'raced/a.md').toString('utf8') } catch (value) { error = (value as Error).message }
  expect({ returned, error, bytesRead: io.bytes }).toEqual({ returned: undefined, error: expect.stringContaining('changed'), bytesRead: 0 })
  expect(() => fstatSync(io.lastFd!)).toThrow()
  io.onOpen = undefined
  const short = join(f.root, 'short.md'); writeFileSync(short, 'one')
  const revoked = f.register(short, 'file')
  io.beforeRead = () => { io.beforeRead = undefined; f.resources.revoke(f.a.id, revoked.id) }
  expect(() => f.resources.download(f.a.id, revoked.id, '')).toThrow('revoked')
  expect(() => fstatSync(io.lastFd!)).toThrow()
})
