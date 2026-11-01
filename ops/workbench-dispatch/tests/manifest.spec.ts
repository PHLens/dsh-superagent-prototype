import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { loadManifest, validateManifest, topologicalSort } from '../src/manifest.ts'

const fixture = () => ({
  version: 1, revision: 'fixture-v1', repository: 'PHLens/dsh-superagent-prototype', notes: [],
  capabilities: [{ id: 'session', status: 'untested', description: 'Native session persistence' }],
  tasks: ['A', 'B', 'C'].map((id, index) => ({
    id, title: `Task ${id}`, prompt: `Implement ${id} within the listed files.`,
    files: { create: [`ops/fixture/${id}.ts`], test: [`ops/fixture/${id}.spec.ts`] } as { create?: string[]; test?: string[] },
    dependsOn: index === 0 ? [] : ['A'], capabilities: index === 0 ? [] : ['session'],
    baseBranch: 'dev', expectedHead: `workbench/${id}`, acceptance: ['node --test'],
    verification: ['Review passing test output and merged PR evidence.'], blockedBy: [] as string[],
  })),
})

const invalid = (change: (value: ReturnType<typeof fixture>) => void, message: RegExp) => {
  const input = fixture()
  change(input)
  assert.throws(() => validateManifest(input), message)
}

describe('standalone dispatch manifest', () => {
  it('validates a manifest and sorts all dependencies before consumers deterministically', () => {
    const input = fixture()
    input.tasks.reverse()
    const manifest = validateManifest(input)
    assert.deepEqual(topologicalSort(manifest).map(task => task.id), ['A', 'C', 'B'])
    assert.deepEqual(input.tasks.map(task => task.id), ['C', 'B', 'A'])
  })

  it('rejects duplicate task/capability ids and ambiguous PR heads', () => {
    invalid(value => { value.tasks[1]!.id = 'A' }, /Duplicate task id: A/)
    invalid(value => { value.capabilities.push(value.capabilities[0]!) }, /Duplicate capability id: session/)
    invalid(value => { value.tasks[1]!.expectedHead = value.tasks[0]!.expectedHead }, /Duplicate expectedHead/)
  })

  it('rejects unknown dependencies and capability names', () => {
    invalid(value => { value.tasks[0]!.dependsOn = ['missing'] }, /Unknown dependency.*missing/)
    invalid(value => { value.tasks[0]!.capabilities = ['missing'] }, /Unknown capability.*missing/)
  })

  it('rejects self cycles and cycles in disconnected components with a path', () => {
    invalid(value => { value.tasks[0]!.dependsOn = ['A'] }, /Dependency cycle: A -> A/)
    invalid(value => {
      value.tasks[1]!.dependsOn = ['C']
      value.tasks[2]!.dependsOn = ['B']
    }, /Dependency cycle: B -> C -> B/)
  })

  it('requires branch, acceptance, capability declarations and a nonempty file scope', () => {
    for (const field of ['baseBranch', 'expectedHead', 'acceptance', 'capabilities']) {
      invalid(value => { delete (value.tasks[0] as Record<string, unknown>)[field] }, new RegExp(field))
    }
    invalid(value => { value.tasks[0]!.acceptance = [] }, /acceptance/)
    invalid(value => { value.tasks[0]!.expectedHead = '' }, /expectedHead/)
    invalid(value => { value.tasks[0]!.files = {} }, /files/)
    invalid(value => { value.tasks[0]!.capabilities = [''] }, /capabilities/)
    invalid(value => { value.tasks[0]!.baseBranch = 'main' }, /baseBranch/)
  })

  it('rejects malformed values, unsupported versions and misspelled fields', () => {
    for (const value of [null, [], {}, { ...fixture(), version: 2 }, { ...fixture(), task: [] }]) {
      assert.throws(() => validateManifest(value))
    }
    invalid(value => { value.capabilities[0]!.status = 'green' }, /status/)
    invalid(value => { value.tasks[0]!.prompt = '  ' }, /prompt/)
    invalid(value => { value.tasks[0]!.dependsOn = ['B', 'B'] }, /dependsOn.*Duplicate/)
    invalid(value => { value.tasks[0]!.files.create = ['/private/local/file.ts'] }, /relative/)
    invalid(value => { value.tasks[0]!.files.create = ['../escape.ts'] }, /relative/)
  })

  it('does not promote untested capabilities or blocked tasks when sorting', () => {
    const input = fixture()
    input.tasks[0]!.blockedBy = ['Owner decision required']
    const manifest = validateManifest(input)
    assert.equal(topologicalSort(manifest)[0]!.blockedBy[0], 'Owner decision required')
    assert.equal(manifest.capabilities[0]!.status, 'untested')
  })

  it('loads the versioned task inventory with all defined later increment tasks', async () => {
    const manifest = await loadManifest(new URL('../manifest.yaml', import.meta.url))
    const expected = [
      ...'ABCDE'.split('').map(id => `0${id}`), ...'ABCDEFGHIJKL'.split('').map(id => `1${id}`),
      ...'ABCDEFG'.split('').map(id => `2${id}`), ...'ABCD'.split('').map(id => `3${id}`),
      ...'01234'.split('').map(id => `D${id}`),
    ]
    assert.deepEqual(manifest.tasks.map(task => task.id).sort(), expected.sort())
    const ordered = topologicalSort(manifest).map(task => task.id)
    for (const task of manifest.tasks) {
      for (const dependency of task.dependsOn) assert.ok(ordered.indexOf(dependency) < ordered.indexOf(task.id))
    }
    for (const id of ['1A', '1B', 'D0']) assert.deepEqual(manifest.tasks.find(task => task.id === id)!.capabilities, [])
    assert.ok(manifest.capabilities.every(capability => capability.status === 'untested'))
  })

  it('keeps the published JSON Schema required fields aligned with the runtime contract', async () => {
    const schema = JSON.parse(await readFile(new URL('../manifest.schema.json', import.meta.url), 'utf8'))
    assert.deepEqual(schema.$defs.task.required.sort(), Object.keys(fixture().tasks[0]!).sort())
    assert.deepEqual(schema.required.sort(), Object.keys(fixture()).sort())
    assert.equal(schema.$defs.task.properties.baseBranch.const, 'dev')
    assert.deepEqual(schema.$defs.capability.properties.status.enum,
      ['passed', 'failed', 'unsupported', 'untested', 'not_applicable', 'amber'])
  })

  it('runs the real check CLI and reports invalid arguments and missing files without writes', () => {
    const entry = fileURLToPath(new URL('../src/manifest.ts', import.meta.url))
    const manifest = fileURLToPath(new URL('../manifest.yaml', import.meta.url))
    const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', entry, ...args], { encoding: 'utf8' })
    const success = run('--check', manifest)
    assert.equal(success.status, 0, success.stderr)
    assert.match(success.stdout, /Manifest valid: 33 tasks/)
    assert.notEqual(run('--check', `${manifest}.missing`).status, 0)
    assert.match(run('--wat').stderr, /Usage:/)
    assert.notEqual(run('--check', manifest, 'extra').status, 0)
  })
})
