/** Fixture-only startup checks: no host accounts or external CLIs are used. */
import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as environment from '../src/infra/environment.ts'
import { SetupError } from '../src/setup.ts'
import { resolveDeployment } from '../src/deployment.ts'
import { testMachine } from './fixtures/deployment.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined; vi.restoreAllMocks() })

it('resolves an empty deployment without PATH or account probes', async () => {
  const probe = vi.fn(async () => { throw new Error('unexpected resource probe') })
  const deployment = await resolveDeployment(testMachine(), undefined, probe, '')
  expect(deployment.github).toBeUndefined()
  expect(deployment.repository).toBe('')
  expect(probe).not.toHaveBeenCalled()
})

it('does not probe a disabled GitHub resource even when its saved CLI is invalid', async () => {
  host = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, sources: {
      github: { ...settings.sources.github!, enabled: false, config: { repository: 'acme/widgets', cli: '/missing/gh' } },
      feishu: { ...settings.sources.feishu!, enabled: false, config: { cli: '/missing/lark-cli' } },
    } })
  })
  expect(host.runtime.configured()).toBe(true)
  expect(host.runtime.setupProblem).toBeUndefined()
  expect(host.runtime.feishuProblem).toBeUndefined()
  expect(host.runtime.deployment.github).toBeUndefined()
  expect(host.runtime.deployment.feishu).toBeUndefined()
  expect(host.subprocess.spawn).not.toHaveBeenCalled()
})

it('keeps base and Feishu ready when GitHub credential-helper validation fails', async () => {
  vi.spyOn(environment, 'verifyEnvironment').mockImplementation(async deployment => { if (deployment.github) throw new SetupError('gitTooOld') })
  host = await startRuntime()
  expect(host.runtime.configured()).toBe(true)
  expect(host.runtime.health.runtime?.state).toBe('ready')
  expect(host.runtime.setup.problem).toBeUndefined()
  expect(host.runtime.setup.githubProblem?.code).toBe('gitTooOld')
  expect(host.runtime.deployment.github).toBeUndefined()
  expect(host.runtime.deployment.repository).toBe('')
  expect(host.runtime.deployment.feishu?.botId).toBe('ou_bot')
  expect(host.agents.has(host.runtime.masterId)).toBe(true)
  const calls = host.subprocess.spawn.mock.calls.map(([spec]) => spec.argv.join(' '))
  expect(calls.some(call => call.includes('api user'))).toBe(true)
  expect(calls.some(call => call.includes('api repos/acme/widgets'))).toBe(true)
  expect(await readFile(join(host.directory, 'worker-bin', 'gh'), 'utf8')).toContain('no GitHub resource')
  expect(await readFile(environment.workerGitConfig(host.directory), 'utf8')).not.toContain('auth git-credential')
  const first = host.runtime.projects.create({ name: 'First', goal: 'Save local notes' })
  const second = host.runtime.projects.create({ name: 'Second', goal: 'Discuss a plan' })
  expect(host.runtime.projects.get(first.id)).toEqual(first)
  expect(host.runtime.projects.get(second.id)).toEqual(second)
  expect(host.runtime.projects.list()).toEqual(expect.arrayContaining([first, second]))
})

it.each([
  ['base environment write failure', new Error('disk full'), 'environmentFailed'],
  ['foreign environment file', new SetupError('foreignFile', { file: '/tmp/foreign' }), 'foreignFile'],
] as const)('%s keeps Runtime paused without a master session', async (_label, failure, code) => {
  vi.spyOn(environment, 'writeEnvironment').mockRejectedValue(failure)
  host = await startRuntime()
  expect(host.runtime.configured()).toBe(false)
  expect(host.runtime.health.runtime?.state).toBe('paused')
  expect(host.runtime.setupProblem?.code).toBe(code)
  expect(host.agents.has(host.runtime.masterId)).toBe(false)
})

it('blocks startup when removing rejected GitHub credentials fails', async () => {
  const originalWrite = environment.writeEnvironment
  const beforePath = process.env.PATH
  vi.spyOn(environment, 'verifyEnvironment').mockRejectedValue(new SetupError('gitTooOld'))
  vi.spyOn(environment, 'writeEnvironment').mockImplementation(async (deployment, blocked) => {
    if (!deployment.github) throw new Error('cannot remove credential helper')
    await originalWrite(deployment, blocked)
  })
  host = await startRuntime()
  expect(host.runtime.configured()).toBe(false)
  expect(host.runtime.health.runtime?.state).toBe('paused')
  expect(host.runtime.setup.problem?.code).toBe('environmentFailed')
  expect(host.runtime.setup.githubProblem?.code).toBe('gitTooOld')
  expect(host.agents.has(host.runtime.masterId)).toBe(false)
  expect(process.env.PATH).toBe(beforePath)
})

it('starts Runtime and its main session without external source configuration', async () => {
  host = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, sources: {} })
  })
  expect(host.runtime.configured()).toBe(true)
  expect(host.runtime.health.runtime?.state).toBe('ready')
  expect(host.runtime.setupProblem).toBeUndefined()
  expect(host.runtime.context({ kind: 'github', health: ['github'] }).configured()).toBe(false)
  expect(host.runtime.deployment.github).toBeUndefined()
  const first = host.runtime.projects.create({ name: 'First', goal: 'Save local notes' })
  const second = host.runtime.projects.create({ name: 'Second', goal: 'Discuss a plan' })
  expect(first.id).not.toBe(second.id)
  expect(host.runtime.projects.get(first.id)).toEqual(first)
  expect(host.runtime.projects.get(second.id)).toEqual(second)
  expect(host.runtime.projects.list()).toEqual(expect.arrayContaining([first, second]))
})
