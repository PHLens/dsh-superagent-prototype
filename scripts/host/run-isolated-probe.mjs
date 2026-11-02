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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateSessionResults(create, reopen, context) {
  if (!isObject(create) || !isObject(reopen)) throw new Error('Session results must be objects')
  const common = ['profile', 'dshHome', 'stateDir', 'workspace', 'port']
  for (const result of [create, reopen]) {
    if (!common.every(key => result[key] === context[key]) || result.hostContext !== true) {
      throw new Error('Session common observations did not match expectations')
    }
    if (!isObject(result.session)) throw new Error('Session result missing session evidence')
    const session = result.session
    if (session.id !== `${context.profile}-session` || typeof session.workspaceId !== 'string' || !session.workspaceId) {
      throw new Error('Session identifiers are missing')
    }
    if (session.cwd !== context.workspace || session.workspacePath !== context.workspace || session.realpath !== context.workspace) {
      throw new Error('Session workspace paths did not match expectations')
    }
    if (session.permissionPreset !== 'workspace-write' || session.sandboxMode !== 'workspace-write' || session.approvalPolicy !== 'ask') {
      throw new Error('Session permission observations did not match expectations')
    }
    if (!Number.isInteger(session.eventCount) || session.eventCount < 1 || session.mappingRejected !== true || !Number.isInteger(session.pid) || session.pid < 1) {
      throw new Error('Session event or process observations did not match expectations')
    }
  }
  if (create.session.id !== reopen.session.id || create.session.workspaceId !== reopen.session.workspaceId || create.session.eventCount !== reopen.session.eventCount) {
    throw new Error('Session identity or durable event count was not stable across restart')
  }
  if (create.session.pid === reopen.session.pid) throw new Error('Session restart reused the host process')
}

export async function runProbe({ capability = 'launcher', timeoutMs = 120000, command = 'dsh', signal } = {}) {
  if (!['launcher', 'session'].includes(capability)) throw new Error('Only launcher and session are implemented; skills/web remain untested')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Timeout must be 1..120000 milliseconds')
  if (process.platform === 'win32') throw new Error('Process-group cleanup requires a POSIX host')
  const startedAt = new Date().toISOString(), deadline = Date.now() + timeoutMs
  const evidence = {
    schemaVersion: 1, baseline, capability, status: 'failed', command: [],
    expected: capability === 'session'
      ? 'Native Session and Workspace persist across two isolated host processes; cwd/realpath and permission overrides survive; mismatched mapping is rejected; cleanup passes'
      : 'Only the isolated probe plugin boots; state and loopback round trips pass; outbound is rejected; owned processes and files are removed',
    actual: null, host: { node: process.version, platform: process.platform, architecture: process.arch, dsh: null },
    context: null, startedAt, finishedAt: null, budgetMs: timeoutMs, execution: null, restartExecution: null,
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
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const writePatch = async sessionPhase => {
      const config = sessionPhase ? { ...context, sessionPhase } : context
      const entries = sessionPhase ? [
        { id: 'storage', name: '@deepseek-ai/dsh-storage', config: {} },
        { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json', config: { root: join(context.stateDir, 'storage') } },
        { id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
        { id: 'session', name: '@deepseek-ai/dsh-session', config: {} },
        { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection', config: {} },
        { id: 'session-persistence-jsonl', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: join(context.stateDir, 'sessions') } },
        { id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'read-only', workspaceRoot: context.workspace } },
        { id: 'subprocess-local', name: '@deepseek-ai/dsh-subprocess-local', config: {} },
        { id: 'sandbox-local', name: '@deepseek-ai/dsh-sandbox-local', config: {} },
        { id: 'bash-sandbox', name: '@deepseek-ai/dsh-bash-sandbox', config: { cwd: context.workspace } },
        { id: 'user-approval', name: '@deepseek-ai/dsh-user-approval', config: { policy: 'never' } },
        { id: 'workspace', name: '@deepseek-ai/dsh-workspace', config: {} },
        { id: 'permission-presets', name: '@deepseek-ai/dsh-permission-presets', config: { defaultPreset: sessionPhase === 'reopen' ? 'danger-full-access' : 'workspace-write' } },
      ] : []
      entries.push({ id: 'isolated-probe', name: './probe-host-plugin.ts', config })
      await writeFile(patchPath, JSON.stringify([{ insert: entries }]), { mode: 0o600, flag: sessionPhase === undefined ? 'wx' : undefined })
    }
    await writePatch(capability === 'session' ? 'create' : undefined)
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
    if (capability === 'session') {
      evidence.actual = { create: null, reopen: null }
      evidence.actual.create = JSON.parse(await readFile(join(context.stateDir, 'result-create.json'), 'utf8'))
      if (evidence.execution.exitCode !== 0 || evidence.execution.error || evidence.execution.timedOut || evidence.execution.interrupted || evidence.execution.cleanup !== 'passed') {
        throw new Error('Session create host execution failed')
      }
      await writePatch('reopen')
      evidence.restartExecution = await execute(['--profile', profile])
      evidence.cleanup.processes = evidence.cleanup.processes === 'passed' && evidence.restartExecution.cleanup === 'passed' ? 'passed' : 'failed'
      evidence.actual.reopen = JSON.parse(await readFile(join(context.stateDir, 'result-reopen.json'), 'utf8'))
      if (evidence.restartExecution.exitCode !== 0 || evidence.restartExecution.error || evidence.restartExecution.timedOut || evidence.restartExecution.interrupted || evidence.restartExecution.cleanup !== 'passed') {
        throw new Error('Session reopen host execution failed')
      }
      validateSessionResults(evidence.actual.create, evidence.actual.reopen, context)
      evidence.status = 'passed'
    } else {
      const result = JSON.parse(await readFile(join(context.stateDir, 'result.json'), 'utf8'))
      if (!isObject(result)) throw new Error('Host result must be an object')
      evidence.actual = result
      const match = ['profile', 'dshHome', 'stateDir', 'workspace', 'port'].every(key => result[key] === context[key])
      const success = match && result.stateRoundtrip === true && result.loopbackRoundtrip === true && result.outboundRejected === true && result.hostContext === true
      if (evidence.execution.exitCode === 0 && !evidence.execution.timedOut && !evidence.execution.interrupted && success) evidence.status = 'passed'
      else evidence.error = 'Host exit or observations did not match expectations'
    }
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
    if (capability === 'session') evidence.capabilities.session = evidence.status === 'passed' ? 'passed' : 'failed'
    evidence.finishedAt = new Date().toISOString()
  }
  return evidence
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--capability' || args[2] !== '--json') throw new Error('Usage: node scripts/host/run-isolated-probe.mjs --capability <launcher|session> --json .superagent-host/<new-output>.json (new output filename each run)')
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
