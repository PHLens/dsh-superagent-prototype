#!/usr/bin/env node
// Raw evidence stays local: it contains temporary absolute paths and host diagnostics.
import { spawn } from 'node:child_process'
import { randomUUID, randomInt } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const baseline = '7a68779c32e8dcf2ef9f4c942fdc7c24b25c05bb'
const plugin = new URL('./probe-host-plugin.ts', import.meta.url)
const limit = 65536
const pause = ms => new Promise(done => setTimeout(done, ms))

// Deny network egress before the DSH host is imported. Only numeric loopback is
// permitted; do not resolve arbitrary names, discover credentials or load Sources.
const guard = `
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const denied = () => { throw Object.assign(new Error('Probe outbound disabled'), {code:'PROBE_OUTBOUND_DISABLED'}); };
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof a === 'object' ? a.host : typeof args[1] === 'string' ? args[1] : undefined;
  if (a?.path || (host !== '127.0.0.1' && host !== '::1')) return denied();
  return original.apply(this,args);
};
dgram.createSocket = denied;
dgram.Socket.prototype.send = denied;
dgram.Socket.prototype.connect = denied;
const lookup = dns.lookup, promiseLookup = dns.promises.lookup;
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (key === 'lookup' || key === 'lookupService' || key.startsWith('resolve') || key === 'reverse') target[key] = denied;
  }
}
dns.lookup = function(host,...args) {
  if (host !== '127.0.0.1' && host !== '::1') return denied();
  return lookup.call(this,host,...args);
};
dns.promises.lookup = function(host,...args) {
  if (host !== '127.0.0.1' && host !== '::1') return denied();
  return promiseLookup.call(this,host,...args);
};
// A host-only probe needs no subprocesses, including detached delivery helpers.
for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[key] = denied;
childProcess.ChildProcess.prototype.spawn = denied;
globalThis.fetch = denied;
syncBuiltinESMExports();
`

export function isolatedEnv(context, root, parent = process.env) {
  return {
    PATH: parent.PATH ?? '', HOME: join(root, 'home'), DSH_HOME: context.dshHome,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: context.stateDir,
    XDG_CACHE_HOME: join(root, 'cache'), TMPDIR: join(root, 'tmp'),
    DSH_PROBE_OUTBOUND_DISABLED: '1', DSH_TELEMETRY_DISABLED: '1', CI: '1', NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'guard.mjs')).href}`,
  }
}

export async function choosePort() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const port = randomInt(20000, 60000)
    if (port === 3082 || port === 53818) continue
    const server = createServer()
    try {
      await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done) })
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
      return port
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error('No isolated loopback port available')
}

function groupAlive(pid) {
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

// Fixture commands use the same supervisor, never the operator's environment.
export async function supervise(command, args, { env, cwd, timeoutMs, signal }) {
  const started = Date.now()
  let output = '', truncated = false, error = null, timedOut = false, interrupted = false
  let cleanupError = null, drainTimer
  const child = spawn(command, args, { env, cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const kill = () => {
    if (!child.pid) return
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL') }
    catch (cause) { if (cause.code !== 'ESRCH') cleanupError = cause.code }
  }
  const drain = () => {
    drainTimer ??= setTimeout(() => {
      // Escaped/inherited pipes must not suppress the exit record indefinitely.
      cleanupError ??= 'PIPE_DRAIN_TIMEOUT'
      child.stdout.destroy()
      child.stderr.destroy()
    }, 250)
  }
  const abort = () => { interrupted = true; kill(); drain() }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const capture = data => {
    const text = data.toString()
    truncated ||= output.length + text.length > limit
    output += text.slice(0, Math.max(0, limit - output.length))
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.on('error', cause => { error = cause.code ?? 'SPAWN_ERROR' })
  // Kill descendants immediately on parent exit, before waiting for inherited pipes.
  child.on('exit', () => { kill(); drain() })
  const timer = setTimeout(() => { timedOut = true; kill(); drain() }, Math.max(1, timeoutMs))
  const [exitCode, exitSignal] = await new Promise(done => child.once('close', (...result) => done(result)))
  clearTimeout(timer)
  clearTimeout(drainTimer)
  signal?.removeEventListener('abort', abort)
  kill()
  let processesGone = !child.pid
  if (child.pid) {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!groupAlive(child.pid)) { processesGone = true; break }
      await pause(20)
    }
  }
  return { command: [command, ...args], exitCode, signal: exitSignal, error, timedOut, interrupted,
    durationMs: Date.now() - started, output, truncated, processesGone,
    cleanup: processesGone && !cleanupError ? 'passed' : 'failed', cleanupError }
}

export async function runProbe({ capability = 'launcher', timeoutMs = 120000, command = 'dsh', signal } = {}) {
  if (capability !== 'launcher') throw new Error('Only launcher is implemented; session/skills/web remain untested')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Timeout must be 1..120000 milliseconds')
  if (process.platform === 'win32') throw new Error('Process-group cleanup requires a POSIX host')
  const startedAt = new Date().toISOString(), deadline = Date.now() + timeoutMs
  const evidence = {
    schemaVersion: 1, baseline, capability, status: 'failed', command: [],
    expected: 'Only the isolated probe plugin boots; state and loopback round trips pass; outbound is rejected; owned processes and files are removed',
    actual: null, host: { node: process.version, platform: process.platform, architecture: process.arch, dsh: null },
    context: null, startedAt, finishedAt: null, budgetMs: timeoutMs, execution: null,
    cleanup: { processes: 'untested', directory: 'untested', port: 'untested' }, error: null,
    capabilities: { session: 'untested', skills: 'untested', web: 'untested' },
  }
  let root
  try {
    // Canonical parent avoids /var versus /private/var aliases on macOS.
    const parent = await realpath(tmpdir())
    root = await mkdtemp(join(parent, 'dsh-host-probe-'))
    const profile = `probe-${randomUUID()}`
    const context = { profile, dshHome: join(root, 'dsh'), stateDir: join(root, 'state'),
      workspace: join(root, 'workspace'), port: await choosePort(), outboundDisabled: true, startedAt }
    evidence.context = context
    const profileDir = join(context.dshHome, 'profiles', profile)
    const env = isolatedEnv(context, root)
    for (const dir of [profileDir, context.stateDir, context.workspace, env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.TMPDIR]) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
    }
    await writeFile(join(root, 'empty.gitconfig'), '', { mode: 0o600, flag: 'wx' })
    await writeFile(join(root, 'guard.mjs'), guard, { mode: 0o600, flag: 'wx' })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ private: true, type: 'module', dsh: { profile: { bundles: [] } } }), { mode: 0o600, flag: 'wx' })
    await writeFile(join(profileDir, 'probe-host-plugin.ts'), await readFile(plugin), { mode: 0o600, flag: 'wx' })
    // JSON is valid YAML; no expression evaluation or imported bundle is needed.
    await writeFile(join(profileDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [{
      id: 'isolated-probe', name: './probe-host-plugin.ts', config: context,
    }] }]), { mode: 0o600, flag: 'wx' })
    const execute = async args => {
      if (signal?.aborted || Date.now() >= deadline) throw new Error('Probe budget exhausted or interrupted')
      return supervise(command, args, { env, cwd: context.workspace, timeoutMs: deadline - Date.now(), signal })
    }
    const version = await execute(['--version'])
    evidence.host.dsh = version.output.trim()
    evidence.versionExecution = version
    evidence.cleanup.processes = version.cleanup
    if (version.exitCode !== 0 || version.timedOut || version.interrupted || version.cleanup !== 'passed') throw new Error('DSH version command failed')
    evidence.command = [command, '--profile', profile]
    evidence.execution = await execute(['--profile', profile])
    evidence.cleanup.processes = evidence.execution.cleanup
    const result = JSON.parse(await readFile(join(context.stateDir, 'result.json'), 'utf8'))
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Host result must be an object')
    evidence.actual = result
    const match = ['profile', 'dshHome', 'stateDir', 'workspace', 'port'].every(key => result[key] === context[key])
    const success = match && result.stateRoundtrip === true && result.loopbackRoundtrip === true && result.outboundRejected === true && result.hostContext === true
    if (evidence.execution.exitCode === 0 && !evidence.execution.timedOut && !evidence.execution.interrupted && success) evidence.status = 'passed'
    else evidence.error = 'Host exit or observations did not match expectations'
  } catch (error) {
    evidence.error = error.code ?? error.message
  } finally {
    if (root) {
      try {
        // Check exact ownership and canonical path before removing anything.
        const canonical = await realpath(root)
        if (canonical !== root || dirname(root) !== await realpath(tmpdir()) || !root.split('/').at(-1).startsWith('dsh-host-probe-') || !(await lstat(root)).isDirectory()) throw new Error('Unsafe cleanup target')
        await rm(root, { recursive: true, force: true })
        try { await lstat(root); throw new Error('Temporary root remains') }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        evidence.cleanup.directory = 'passed'
      } catch (error) { evidence.cleanup.directory = 'failed'; evidence.error ??= error.code ?? error.message }
    }
    if (evidence.context && evidence.cleanup.processes === 'passed') {
      const server = createServer()
      try {
        await new Promise((done, reject) => { server.once('error', reject); server.listen(evidence.context.port, '127.0.0.1', done) })
        await new Promise(done => server.close(done))
        evidence.cleanup.port = 'passed'
      } catch { evidence.cleanup.port = 'failed' }
    }
    if (Object.values(evidence.cleanup).some(status => status !== 'passed')) evidence.status = 'failed'
    evidence.finishedAt = new Date().toISOString()
  }
  return evidence
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--capability' || args[2] !== '--json') throw new Error('Usage: node scripts/host/run-isolated-probe.mjs --capability launcher --json .superagent-host/launcher.json (new output filename each run)')
  const output = resolve(args[3])
  // Claim output before spawning: refuse existing files and symlinks without booting.
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  const { open } = await import('node:fs/promises')
  const handle = await open(output, 'wx', 0o600)
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const record = await runProbe({ capability: args[1], signal: controller.signal })
    await handle.writeFile(JSON.stringify(record, null, 2) + '\n')
    console.log(JSON.stringify({ status: record.status, capability: record.capability, cleanup: record.cleanup }))
    process.exitCode = record.status === 'passed' ? 0 : 1
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    await handle.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
