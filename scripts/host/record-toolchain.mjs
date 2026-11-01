#!/usr/bin/env node
// Task 0A only: no host boot, profile access, Runtime import or delivery command.
// Raw evidence contains local paths. Keep it in the ignored .superagent-host directory.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, release } from 'node:os'
import { dirname, delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accessSync, constants, realpathSync } from 'node:fs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const outputLimit = 128 * 1024

function executable(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return { path: candidate, realpath: realpathSync(candidate) }
    } catch { /* Keep searching PATH without changing it. */ }
  }
  return { path: null, realpath: null }
}

export function runCommand(command, args, { timeoutMs, cwd = root } = {}) {
  return new Promise(resolveResult => {
    const started = Date.now()
    let output = '', truncated = false, timedOut = false, error = null
    const grouped = process.platform !== 'win32'
    const child = spawn(command, args, {
      cwd, env: { ...process.env, CI: '1', NO_COLOR: '1' },
      shell: false, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const capture = chunk => {
      const text = chunk.toString()
      if (output.length + text.length > outputLimit) truncated = true
      output += text.slice(0, Math.max(0, outputLimit - output.length))
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.on('error', cause => { error = cause.code ?? 'SPAWN_ERROR' })
    let cleanup = 'passed'
    const kill = () => {
      if (!child.pid) return
      try {
        // The process group belongs to this spawn, never to an operator service.
        if (grouped) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch (cause) {
        if (cause.code !== 'ESRCH') cleanup = 'failed'
      }
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, Math.max(1, timeoutMs ?? 120000))
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      // Also remove descendants that outlive their immediate parent.
      kill()
      resolveResult({ command: [command, ...args], status: exitCode === 0 && !timedOut && !error && cleanup === 'passed' ? 'passed' : 'failed',
        exitCode, signal, error, timedOut, durationMs: Date.now() - started, cleanup, truncated, output })
    })
  })
}

// Resolve via consumers rather than assuming pnpm hoists transitive packages.
const nativeScript = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(process.cwd() + '/package.json');
const fromVitest = createRequire(require.resolve('vitest/package.json'));
const fromVite = createRequire(fromVitest.resolve('vite/package.json'));
const rolldownPath = fromVite.resolve('rolldown');
const lightningPath = fromVite.resolve('lightningcss');
const rolldown = await import(pathToFileURL(rolldownPath).href);
const lightningcss = fromVite('lightningcss');
const js = await rolldown.build({ input: 'data:text/javascript,export%20const%20value%20%3D%201', write: false });
const css = lightningcss.transform({ filename: 'probe.css', code: Buffer.from('a { color: red }'), minify: true });
if (!js.output?.length || !css.code.length) throw new Error('Native transform returned no output');
console.log(JSON.stringify({ rolldown: { path: rolldownPath, transformed: true }, lightningcss: { path: lightningPath, transformed: true } }));
`

export async function recordToolchain({ run = runCommand, timeoutMs = 120000 } = {}) {
  const startedAt = new Date().toISOString()
  const deadline = Date.now() + timeoutMs
  const commands = []
  const execute = async (command, args) => {
    const remaining = deadline - Date.now()
    const result = remaining <= 0
      ? { command: [command, ...args], status: 'untested', reason: 'Shared 120-second budget exhausted', cleanup: 'not_applicable' }
      : await run(command, args, { cwd: root, timeoutMs: remaining })
    commands.push(result)
    return result
  }
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  const node = { path: process.execPath, realpath: realpathSync(process.execPath), version: process.version, required: manifest.engines.node }
  const pnpm = { ...executable('pnpm'), required: manifest.packageManager, ...await execute('pnpm', ['--version']) }
  const dsh = { ...executable('dsh'), required: manifest.engines.dsh, ...await execute('dsh', ['--version']) }
  const packageGraph = await execute('pnpm', ['list', '--depth', '1', '--json'])
  const nativeGraph = await execute('pnpm', ['why', 'rolldown', 'lightningcss', '--json'])
  const nativeOptional = await execute(process.execPath, ['--input-type=module', '-e', nativeScript])
  const checks = {
    typecheck: await execute('pnpm', ['typecheck']),
    testStartup: await execute('pnpm', ['exec', 'vitest', 'run', 'tests/host-toolchain.spec.ts']),
    build: await execute('pnpm', ['build']),
  }
  const firstNativeFailure = commands.find(result => result.status === 'failed' && /native binding|cannot find module.*(?:rolldown|lightningcss)|\.node\b|ERR_DLOPEN_FAILED/i.test(result.output ?? '')) ?? null
  const failures = commands.filter(result => result.status !== 'passed')
  const repairs = failures.map((result, index) => ({
    id: `0A-repair-${index + 1}`, owner: 'Task 0A implementer',
    affectedConsumers: ['0B isolated launcher', 'toolchain-dependent implementation tasks'],
    command: result.command, status: result.status,
    candidate: result === firstNativeFailure
      ? 'Inspect nativeGraph and the first binding error; retry pnpm install --frozen-lockfile with optional packages enabled. Change the lockfile only if graph evidence proves it necessary.'
      : 'Resolve the recorded command error locally; if untested, rerun within a fresh budget.',
    retest: 'node scripts/host/record-toolchain.mjs --out .superagent-host/toolchain.json',
    reentry: 'Recorded failing command and its consuming checks pass on the real host.',
  }))
  return {
    schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), budgetMs: timeoutMs,
    node, pnpm, dsh, cpu: { architecture: process.arch, model: cpus()[0]?.model ?? 'unknown', count: cpus().length },
    os: { platform: process.platform, release: release() },
    lockHash: createHash('sha256').update(await readFile(new URL('../../pnpm-lock.yaml', import.meta.url))).digest('hex'),
    packageGraph, nativeGraph, nativeOptional, checks, commands, firstNativeFailure, repairs,
    status: failures.length ? 'failed' : 'passed',
    cleanup: commands.some(result => result.cleanup === 'failed') ? 'failed'
      : commands.some(result => result.status === 'untested' || result.cleanup === 'not_applicable') ? 'untested'
        : 'passed',
    capabilities: {
      session: { status: 'untested', task: '0C' },
      skills: { status: 'untested', task: '0D' },
      web: { status: 'untested', task: '0E' },
    },
    boundary: 'Toolchain commands only; DSH version is observed, not proof of host API compatibility. No production profile or service is started or modified.',
  }
}

export async function writeEvidence(path, record) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // Exclusive creation prevents following symlinks or overwriting unrelated evidence.
  await writeFile(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await chmod(path, 0o600)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: node scripts/host/record-toolchain.mjs --out .superagent-host/toolchain.json (use a new output filename for each run)')
  const output = resolve(args[1])
  const record = await recordToolchain()
  await writeEvidence(output, record)
  console.log(JSON.stringify({ status: record.status, checks: Object.fromEntries(Object.entries(record.checks).map(([key, value]) => [key, value.status])), cleanup: record.cleanup }))
  process.exitCode = record.status === 'passed' ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
