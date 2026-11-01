import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error The standalone Node recorder deliberately has no build dependency.
import { recordToolchain, runCommand, writeEvidence } from '../scripts/host/record-toolchain.mjs'

const success = async (command: string, args: string[]) => ({
  command: [command, ...args], status: 'passed', exitCode: 0, signal: null,
  durationMs: 1, timedOut: false, cleanup: 'passed', output: 'fixture-only',
})

describe('toolchain evidence (fixtures do not certify the real host)', () => {
  it('records identity, lock hash, graph and each executed check', async () => {
    const record = await recordToolchain({ run: success })
    for (const key of ['node', 'pnpm', 'dsh', 'cpu', 'lockHash', 'commands', 'status']) {
      expect(record).toHaveProperty(key)
    }
    expect(record.lockHash).toBe(createHash('sha256').update(await readFile('pnpm-lock.yaml')).digest('hex'))
    expect(record.packageGraph.status).toBe('passed')
    for (const key of ['typecheck', 'testStartup', 'build']) {
      expect(record.checks[key]).toMatchObject({ status: 'passed', exitCode: 0 })
      expect(record.checks[key].command).toContain('pnpm')
    }
    expect(record.capabilities.session.status).toBe('untested')
    expect(record.status).toBe('passed')
  })

  it('does not turn installed packages into success and names a bounded native repair', async () => {
    const run = async (command: string, args: string[]) => {
      const result = await success(command, args)
      if (args.includes('build') || args.includes('--input-type=module')) {
        return { ...result, status: 'failed', exitCode: 1, output: 'Cannot find native binding @rolldown/binding-darwin-arm64' }
      }
      return result
    }
    const record = await recordToolchain({ run })
    expect(record.status).toBe('failed')
    expect(record.checks.build.status).toBe('failed')
    expect(record.nativeOptional.status).toBe('failed')
    expect(record.firstNativeFailure.output).toContain('Cannot find native binding')
    expect(record.repairs[0]).toMatchObject({ owner: 'Task 0A implementer' })
    expect(record.repairs[0].retest).toContain('node scripts/host/record-toolchain.mjs')
    expect(record.repairs[0].affectedConsumers).not.toHaveLength(0)
  })

  it('leaves checks untested after the shared deadline instead of claiming success', async () => {
    const delayed = async (command: string, args: string[], options: { timeoutMs?: number }) => {
      expect(options.timeoutMs).toBeDefined()
      await new Promise(resolve => setTimeout(resolve, 5))
      return success(command, args)
    }
    const record = await recordToolchain({ run: delayed, timeoutMs: 1 })
    expect(record.status).toBe('failed')
    expect(record.checks.typecheck.status).toBe('untested')
    expect(record.checks.testStartup.status).toBe('untested')
    expect(record.checks.build.status).toBe('untested')
    expect(record.cleanup).toBe('untested')
  })

  it('records missing commands as failed and bounds captured output', async () => {
    expect(await runCommand('missing-host-toolchain-executable', [], { timeoutMs: 500 }))
      .toMatchObject({ status: 'failed', error: 'ENOENT', cleanup: 'passed' })
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], { timeoutMs: 2000 })
    expect(result.status).toBe('passed')
    expect(result.truncated).toBe(true)
    expect(result.output.length).toBeLessThan(140000)
  })

  it('kills a timed out command and records cleanup', async () => {
    const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 })
    expect(result).toMatchObject({ status: 'failed', timedOut: true, cleanup: 'passed' })
  })

  it('writes private local evidence with restrictive permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'toolchain-test-'))
    try {
      const output = join(dir, 'evidence.json')
      await writeEvidence(output, { status: 'failed', secretFixture: 'not-for-commit' })
      expect(JSON.parse(await readFile(output, 'utf8')).status).toBe('failed')
      const { stat } = await import('node:fs/promises')
      expect((await stat(output)).mode & 0o777).toBe(0o600)
    } finally {
      // The target is the exact directory returned by mkdtemp above.
      await rm(dir, { recursive: true, force: true })
    }
  })
})
