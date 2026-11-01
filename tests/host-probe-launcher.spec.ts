import { mkdtemp, readFile, writeFile, rm, realpath, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { createServer } from 'node:net'
import type { ProbeContext } from '../scripts/host/probe-host-plugin.ts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
// @ts-expect-error Standalone launcher intentionally runs without a build step.
import { baseline, isolatedEnv, runProbe, supervise } from '../scripts/host/run-isolated-probe.mjs'

const schema = JSON.parse(await readFile('scripts/host/probe-schema.json', 'utf8'))
const validator = z.fromJSONSchema(schema)
const launcher = join(process.cwd(), 'scripts/host/run-isolated-probe.mjs')

async function fixture(body: string, use: (command: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'probe-test-'))
  try {
    const command = join(root, 'fixture-host.mjs')
    await writeFile(command, '#!/usr/bin/env node\n' + body, { mode: 0o700 })
    await use(command, root)
  } finally {
    // Exact owned fixture directory, never the repository or a computed parent.
    expect(dirname(root)).toBe(await realpath(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
}

const version = 'if (process.argv.includes("--version")) { console.log("fixture-only"); process.exit(0) }\n'
const success = version + `
import {readFile,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
const profile = process.argv.at(-1);
const dir = join(process.env.DSH_HOME,'profiles',profile);
const patch = JSON.parse(await readFile(join(dir,'cordis.patch.yml'),'utf8'));
const c = patch[0].insert[0].config;
if (patch.length !== 1 || patch[0].insert.length !== 1 || !c.outboundDisabled) process.exit(9);
if (process.env.FIXTURE_SECRET || process.env.DSH_SUPERAGENT_DIR || process.env.GITHUB_TOKEN || process.env.NODE_EXTRA_CA_CERTS) process.exit(10);
if (process.cwd() !== c.workspace || process.env.HOME !== join(dirname(c.dshHome),'home')) process.exit(11);
await writeFile(join(c.stateDir,'result.json'),JSON.stringify({...c,hostContext:true,stateRoundtrip:true,loopbackRoundtrip:true,outboundRejected:true}));
`

function childOptions(timeoutMs = 2000) {
  return { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs }
}

async function expectRemoved(record: any) {
  expect(record.cleanup.directory).toBe('passed')
  await expect(lstat(dirname(record.context.dshHome))).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('isolated launcher (fixture observations do not certify native capabilities)', () => {
  it('whitelists the child environment, replacing inherited operator configuration', () => {
    const root = join(tmpdir(), 'fixture-root')
    const context: Pick<ProbeContext, 'dshHome' | 'stateDir'> = { dshHome: join(root, 'dsh'), stateDir: join(root, 'state') }
    const env = isolatedEnv(context, root, {
      PATH: 'fixture-path', HOME: '/operator', DSH_HOME: '/operator/dsh', NODE_OPTIONS: '--require=secret',
      GITHUB_TOKEN: 'fixture-secret', DSH_SUPERAGENT_DIR: '/operator/state', FIXTURE_SECRET: 'secret',
    })
    expect(env.PATH).toBe('fixture-path')
    expect(env.HOME).toBe(join(root, 'home'))
    expect(env.DSH_HOME).toBe(context.dshHome)
    expect(env.XDG_STATE_HOME).toBe(context.stateDir)
    expect(env.GIT_CONFIG_GLOBAL).toBe(join(root, 'empty.gitconfig'))
    expect(env.NODE_OPTIONS).toContain('guard.mjs')
    for (const key of ['GITHUB_TOKEN', 'DSH_SUPERAGENT_DIR', 'FIXTURE_SECRET']) expect(env).not.toHaveProperty(key)
  })

  it('runs twice with disjoint homes, profiles, state, workspaces and ports; preserves siblings', async () => {
    await fixture(success, async (command, root) => {
      const sentinel = join(root, 'operator-fixture.txt')
      await writeFile(sentinel, 'unchanged')
      const first = await runProbe({ command })
      const second = await runProbe({ command })
      for (const record of [first, second]) {
        expect(validator.safeParse(record).success).toBe(true)
        expect(record).toMatchObject({ baseline, status: 'passed', capabilities: { session: 'untested', skills: 'untested', web: 'untested' } })
        expect(record.context.port).not.toBe(3082)
        expect(record.context.port).not.toBe(53818)
        expect(record.cleanup).toEqual({ processes: 'passed', directory: 'passed', port: 'passed' })
        await expectRemoved(record)
      }
      for (const key of ['profile', 'dshHome', 'stateDir', 'workspace', 'port']) expect(first.context[key]).not.toBe(second.context[key])
      expect(await readFile(sentinel, 'utf8')).toBe('unchanged')
    })
  })

  it('records startup failure, missing result, and malformed evidence without passing', async () => {
    for (const body of [version + 'process.exit(7)', version, success.replace('JSON.stringify({...c,hostContext:true,stateRoundtrip:true,loopbackRoundtrip:true,outboundRejected:true})', '"malformed"')]) {
      await fixture(body, async command => {
        const record = await runProbe({ command })
        expect(validator.safeParse(record).success).toBe(true)
        expect(record.status).toBe('failed')
        expect(record.error).toBeTruthy()
        await expectRemoved(record)
      })
    }
  })

  it.each(['true', '42', '[]', 'null', '"text"'])('keeps failed %s result evidence schema-valid', async value => {
    const resultExpression = 'JSON.stringify({...c,hostContext:true,stateRoundtrip:true,loopbackRoundtrip:true,outboundRejected:true})'
    await fixture(success.replace(resultExpression, JSON.stringify(value)), async command => {
      const record = await runProbe({ command })
      expect(record).toMatchObject({ status: 'failed', actual: null, error: 'Host result must be an object' })
      expect(validator.safeParse(record).success).toBe(true)
      await expectRemoved(record)
    })
  })

  it('blocks TCP, UDP, DNS, fetch, UNIX sockets and subprocess delivery routes before use', async () => {
    const checks = `
const net = await import('node:net'), udp = await import('node:dgram'), dns = await import('node:dns'), cp = await import('node:child_process');
const direct = new udp.Socket('udp4');
try {
  for (const attempt of [
    () => net.connect(443,'192.0.2.1'),
    () => net.connect({host:'127.0.0.1',path:'/fixture-operator.sock'}),
    () => udp.createSocket('udp4'), () => direct.send('fixture',53,'192.0.2.1'),
    () => direct.connect(53,'192.0.2.1'), () => dns.resolve('example.invalid',()=>{}),
    () => dns.promises.resolve('example.invalid'), () => new dns.Resolver().resolve('example.invalid',()=>{}),
    () => new dns.promises.Resolver().resolve('example.invalid'),
    () => fetch('https://example.invalid'), () => cp.spawn('fixture-delivery-helper'),
    () => new cp.ChildProcess().spawn({file:'fixture-helper',args:[]})
  ]) {
    let blocked = false;
    try { attempt(); } catch (e) { blocked = e.code === 'PROBE_OUTBOUND_DISABLED'; }
    if (!blocked) throw new Error('Guard bypass');
  }
} finally { direct.close(); }
`
    await fixture(success.replace(version, version + checks), async command => {
      const record = await runProbe({ command })
      expect(record.status, JSON.stringify(record)).toBe('passed')
      await expectRemoved(record)
    })
  })

  it('cleans allocated context when the executable is missing', async () => {
    const record = await runProbe({ command: 'missing-isolated-host-executable' })
    expect(record.status).toBe('failed')
    expect(record.versionExecution.error).toBe('ENOENT')
    expect(record.actual).toBeNull()
    expect(validator.safeParse(record).success).toBe(true)
    await expectRemoved(record)
  })

  it('times out a hanging host and removes a symlink without touching its external target', async () => {
    await fixture(version + `
import {symlink} from 'node:fs/promises';
import {join} from 'node:path';
await symlink(${JSON.stringify(process.cwd())},join(process.cwd(),'outside'));
setInterval(()=>{},1000);
`, async command => {
      const record = await runProbe({ command, timeoutMs: 2000 })
      expect(record.status).toBe('failed')
      expect(record.execution.timedOut).toBe(true)
      expect(record.cleanup).toEqual({ processes: 'passed', directory: 'passed', port: 'passed' })
      await expectRemoved(record)
      expect(await readFile('package.json', 'utf8')).toContain('dsh-superagent')
    })
  })

  it('kills a descendant holding inherited pipes when its parent exits', async () => {
    const body = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); setTimeout(()=>process.exit(0),100);`
    const result = await supervise(process.execPath, ['-e', body], childOptions())
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, processesGone: true, cleanup: 'passed' })
  })

  it('bounds escaped inherited pipes and reports cleanup failure instead of hanging', async () => {
    const body = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'}); console.log(c.pid); setTimeout(()=>process.exit(0),100);`
    const result = await supervise(process.execPath, ['-e', body], childOptions())
    const ownedPid = Number(result.output.trim())
    try {
      expect(result).toMatchObject({ exitCode: 0, cleanup: 'failed', cleanupError: 'PIPE_DRAIN_TIMEOUT' })
      expect(result.durationMs).toBeLessThan(2000)
    } finally {
      // This fixture deliberately escaped its original group; the real preload
      // forbids subprocess creation. Kill only the PID reported by this fixture.
      expect(Number.isInteger(ownedPid) && ownedPid > 1).toBe(true)
      process.kill(-ownedPid, 'SIGKILL')
    }
  })

  it('handles abort and output flooding without retaining a child', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 200)
    try {
      const result = await supervise(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000)); setInterval(()=>{},1000)'], { ...childOptions(), signal: controller.signal })
      expect(result).toMatchObject({ interrupted: true, processesGone: true, cleanup: 'passed', truncated: true })
      expect(result.output.length).toBeLessThanOrEqual(65536)
    } finally { clearTimeout(timer) }
  })

  it('never attaches to or terminates an incumbent listener after a port collision', async () => {
    const server = createServer()
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    try {
      const port = (server.address() as { port: number }).port
      const body = `require('node:net').createServer().listen(${port},'127.0.0.1')`
      const result = await supervise(process.execPath, ['-e', body], childOptions())
      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain('EADDRINUSE')
      expect(server.listening).toBe(true)
    } finally { await new Promise<void>(done => server.close(() => done())) }
  })

  it('refuses unsupported capabilities and invalid budgets before host startup', async () => {
    await expect(runProbe({ capability: 'session' })).rejects.toThrow('Only launcher')
    for (const timeoutMs of [0, -1, 120001, NaN]) await expect(runProbe({ timeoutMs })).rejects.toThrow('Timeout')
  })

  it('writes schema-valid private evidence that survives temporary root cleanup', async () => {
    await fixture(success, async (command, root) => {
      await writeFile(join(root, 'dsh'), await readFile(command), { mode: 0o700 })
      const output = join(root, 'evidence.json')
      const result = await supervise(process.execPath, [launcher, '--capability', 'launcher', '--json', output], {
        ...childOptions(10000), env: { PATH: root + delimiter + process.env.PATH },
      })
      expect(result.exitCode, result.output).toBe(0)
      const record = JSON.parse(await readFile(output, 'utf8'))
      expect(validator.safeParse(record).success).toBe(true)
      expect((await lstat(output)).mode & 0o777).toBe(0o600)
      await expectRemoved(record)
    })
  })

  it('refuses existing or symlink evidence files without overwriting them', async () => {
    await fixture('', async (_command, root) => {
      const target = join(root, 'sentinel.json'), link = join(root, 'link.json')
      await writeFile(target, 'keep')
      await symlink(target, link)
      for (const output of [target, link]) {
        const result = await supervise(process.execPath, [launcher, '--capability', 'launcher', '--json', output], childOptions())
        expect(result.exitCode).toBe(1)
        expect(result.output).toContain('EEXIST')
      }
      expect(await readFile(target, 'utf8')).toBe('keep')
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
    })
  })
})
