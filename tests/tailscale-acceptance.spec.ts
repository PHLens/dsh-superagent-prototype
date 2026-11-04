import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { Config, machineOf } from '../src/deployment.ts'
import { registerHttp, sameOrigin } from '../src/app/http.ts'

const base = { stateDir: '/srv/dsh-state' }, origin = 'https://research-machine.example-tailnet.ts.net'

it('requires one exact HTTPS Tailscale Serve origin and rejects wildcard, path, credential and HTTP forms', () => {
  expect(machineOf(Config(base))).not.toHaveProperty('publicOrigin')
  expect(machineOf(Config({ ...base, publicOrigin: origin })).publicOrigin).toBe(origin)
  for (const invalid of ['https://*.example-tailnet.ts.net', 'https://machine.example-tailnet.ts.net/path', 'https://user:secret@machine.example-tailnet.ts.net',
    'http://machine.example-tailnet.ts.net', 'https://machine.example-tailnet.ts.net:443', 'https://machine.example-tailnet.ts.net/']) {
    expect(() => machineOf(Config({ ...base, publicOrigin: invalid })), invalid).toThrow(/exact HTTPS origin/)
  }
})

it('accepts only the exact public Host and Origin while retaining loopback', () => {
  const publicHeaders = { host: 'research-machine.example-tailnet.ts.net', origin, 'x-orchestrator-request': '1' }
  expect(sameOrigin({ headers: publicHeaders }, 3082, origin)).toBe(true)
  for (const headers of [
    { ...publicHeaders, host: 'other.example-tailnet.ts.net' },
    { ...publicHeaders, origin: 'https://other.example-tailnet.ts.net' },
    { ...publicHeaders, origin: 'https://research-machine.example-tailnet.ts.net.evil.test' },
    { ...publicHeaders, 'x-orchestrator-request': undefined },
    { ...publicHeaders, host: '127.0.0.1:3082', origin },
    { host: '127.0.0.1:3082', origin: 'https://research-machine.example-tailnet.ts.net', 'x-orchestrator-request': '1' },
    { host: undefined, origin, 'x-orchestrator-request': '1', 'x-forwarded-host': 'research-machine.example-tailnet.ts.net' },
  ]) expect(sameOrigin({ headers }, 3082, origin), JSON.stringify(headers)).toBe(false)
  expect(sameOrigin({ headers: { host: 'localhost:3082', origin: 'http://localhost:3082', 'x-orchestrator-request': '1' } }, 3082, origin)).toBe(true)
})

it('streams authenticated project facts with the exact public Host and Origin', async () => {
  let handler!: (req: unknown, res: unknown) => Promise<void>
  const page = { projectId: 'p1', cursor: 4, cursorId: 'evt-4', oldestSequence: 4, reset: false,
    events: [{ sequence: 4, event: { id: 'evt-4', projectId: 'p1', ticketId: 't1', kind: 'report-recorded', version: 'v4', operationId: 'v4', at: new Date().toISOString() } }] }
  const events = vi.fn(() => page)
  const ctx = { inject: (_deps: string[], callback: (child: unknown) => void) => {
    callback({ connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, effect: (work: () => unknown) => work() })
    return () => {}
  }, webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), machine: { publicOrigin: origin }, projectCoordinator: { events } } as never)
  const request = Object.assign(new EventEmitter(), { method: 'GET', url: '/orchestrator/api/projects/p1/events/stream?after=0&limit=200',
    headers: { host: 'research-machine.example-tailnet.ts.net', origin, 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() {} })
  const chunks: string[] = []
  class StreamResponse extends EventEmitter {
    writableEnded = false; status = 0; headers: Record<string, string> = {}
    writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers }
    write(value: string) { chunks.push(value); if (value.includes('data: ')) queueMicrotask(() => this.emit('close')); return true }
    end() { this.writableEnded = true }
  }
  const response = new StreamResponse()
  await handler(request, response)
  expect(response.status).toBe(200)
  expect(response.headers['content-type']).toContain('text/event-stream')
  expect(chunks.join('')).toContain('"id":"evt-4"')
  expect(events).toHaveBeenCalledWith('owner', 'p1', 0, undefined, 200)
})


it('downloads an immutable Artifact through the authenticated exact-public download route', async () => {
  let handler!: (req: unknown, res: unknown) => Promise<void>
  const artifactDownload = vi.fn(() => ({ id: 'artifact-1', name: '../acceptance note.md', contentVersion: 'v1', bytes: Buffer.from('# downloaded\n') }))
  const ctx = { inject: (_deps: string[], callback: (child: unknown) => void) => {
    callback({ connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, effect: (work: () => unknown) => work() })
    return () => {}
  }, webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), machine: {}, projectCoordinator: { artifactDownload } } as never)
  const request = Object.assign(new EventEmitter(), { method: 'GET', url: '/orchestrator/api/projects/p1/artifacts/artifact-1/v1/download',
    headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() {} })
  class DownloadResponse extends EventEmitter {
    status = 0; headers: Record<string, string> = {}; chunks: Uint8Array[] = []; writableEnded = false
    writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])) }
    write(value: Uint8Array) { this.chunks.push(value); return true }
    end(value?: Uint8Array) { if (value) this.chunks.push(value); this.writableEnded = true }
  }
  const response = new DownloadResponse()
  await handler(request, response)
  expect(response.status).toBe(200)
  expect(response.headers['content-type']).toBe('application/octet-stream')
  expect(response.headers['content-disposition']).toContain('attachment;')
  expect(response.headers['content-disposition']).not.toContain('\r')
  expect(Buffer.concat(response.chunks).toString()).toBe('# downloaded\n')
  expect(artifactDownload).toHaveBeenCalledWith('owner', 'p1', 'artifact-1', 'v1')
})
