import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DispatchManifest, DispatchTask } from './model.ts'

// This small evaluator supports only the keywords used by our bundled schema.
// It is not a general JSON Schema implementation or a reader for remote schemas.
type Schema = {
  $ref?: string
  type?: 'object' | 'array' | 'string'
  const?: unknown
  enum?: unknown[]
  pattern?: string
  minLength?: number
  minItems?: number
  minProperties?: number
  uniqueItems?: boolean
  additionalProperties?: boolean
  required?: string[]
  properties?: Record<string, Schema>
  items?: Schema
  $defs?: Record<string, Schema>
}
const schema: Schema = JSON.parse(readFileSync(new URL('../manifest.schema.json', import.meta.url), 'utf8'))

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

function fail(path: string, message: string): never {
  throw new ManifestError(`${path}: ${message}`)
}

function checkShape(value: unknown, rule: Schema, path: string): void {
  if (rule.$ref) {
    const name = rule.$ref.replace('#/$defs/', '')
    const target = schema.$defs?.[name]
    if (!target) fail(path, `Unknown bundled schema reference ${rule.$ref}`)
    return checkShape(value, target, path)
  }
  if ('const' in rule && value !== rule.const) fail(path, `Expected ${JSON.stringify(rule.const)}`)
  if (rule.enum && !rule.enum.includes(value)) fail(path, `Expected one of ${rule.enum.join(', ')}`)
  if (rule.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'Expected object')
    const object = value as Record<string, unknown>
    const keys = Object.keys(object)
    if (rule.minProperties && keys.length < rule.minProperties) fail(path, 'Expected nonempty object')
    for (const key of rule.required ?? []) {
      if (!Object.hasOwn(object, key)) fail(`${path}.${key}`, 'Required field missing')
    }
    for (const key of keys) {
      const property = rule.properties?.[key]
      if (property) checkShape(object[key], property, `${path}.${key}`)
      else if (rule.additionalProperties === false) fail(`${path}.${key}`, 'Unknown field')
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value)) fail(path, 'Expected array')
    if (rule.minItems && value.length < rule.minItems) fail(path, 'Expected nonempty array')
    if (rule.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) {
      fail(path, 'Duplicate array entry')
    }
    if (rule.items) value.forEach((item, index) => checkShape(item, rule.items!, `${path}[${index}]`))
  } else if (rule.type === 'string') {
    if (typeof value !== 'string') fail(path, 'Expected string')
    if (rule.minLength && value.length < rule.minLength) fail(path, 'Expected nonempty string')
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) {
      fail(path, path.includes('.files.') ? 'Expected repository-relative path without traversal' : `Invalid string (pattern ${rule.pattern})`)
    }
  }
}

/** Validates structural and graph constraints. This never computes dispatch readiness. */
export function validateManifest(value: unknown): DispatchManifest {
  checkShape(value, schema, 'manifest')
  const manifest = value as DispatchManifest
  const taskIds = new Set<string>()
  const capabilityIds = new Set<string>()
  for (const capability of manifest.capabilities) {
    if (capabilityIds.has(capability.id)) throw new ManifestError(`Duplicate capability id: ${capability.id}`)
    capabilityIds.add(capability.id)
  }
  const heads = new Set<string>()
  for (const task of manifest.tasks) {
    if (taskIds.has(task.id)) throw new ManifestError(`Duplicate task id: ${task.id}`)
    taskIds.add(task.id)
    if (heads.has(task.expectedHead)) throw new ManifestError(`Duplicate expectedHead: ${task.expectedHead}`)
    heads.add(task.expectedHead)
  }
  for (const task of manifest.tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) throw new ManifestError(`Unknown dependency in ${task.id}: ${dependency}`)
    }
    for (const capability of task.capabilities) {
      if (!capabilityIds.has(capability)) throw new ManifestError(`Unknown capability in ${task.id}: ${capability}`)
    }
  }
  topologicalSort(manifest)
  return manifest
}

/** Dependency-first, stable by manifest order; blocked tasks remain in the inventory. */
export function topologicalSort(manifest: DispatchManifest): DispatchTask[] {
  const tasks = new Map(manifest.tasks.map(task => [task.id, task]))
  const done = new Set<string>()
  const active = new Set<string>()
  const path: string[] = []
  const sorted: DispatchTask[] = []
  function visit(task: DispatchTask): void {
    if (done.has(task.id)) return
    if (active.has(task.id)) {
      throw new ManifestError(`Dependency cycle: ${[...path.slice(path.indexOf(task.id)), task.id].join(' -> ')}`)
    }
    active.add(task.id)
    path.push(task.id)
    for (const id of task.dependsOn) {
      const dependency = tasks.get(id)
      if (!dependency) throw new ManifestError(`Unknown dependency in ${task.id}: ${id}`)
      visit(dependency)
    }
    path.pop()
    active.delete(task.id)
    done.add(task.id)
    sorted.push(task)
  }
  for (const task of manifest.tasks) visit(task)
  return sorted
}

/** The versioned .yaml file intentionally uses JSON syntax, a YAML 1.2 subset. */
export async function loadManifest(path: string | URL): Promise<DispatchManifest> {
  const text = await readFile(path, 'utf8')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ManifestError('Manifest must use JSON syntax (the supported YAML 1.2 subset)')
  }
  return validateManifest(value)
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== '--check' || !args[1]) {
    throw new ManifestError('Usage: node --experimental-strip-types ops/workbench-dispatch/src/manifest.ts --check <manifest.yaml>')
  }
  const manifest = await loadManifest(args[1])
  console.log(`Manifest valid: ${manifest.tasks.length} tasks, ${manifest.capabilities.length} capabilities, revision ${manifest.revision}`)
  console.log(`Dependency order: ${topologicalSort(manifest).map(task => task.id).join(' -> ')}`)
  console.log('Structural validation only; capability success and merged PR evidence must be observed separately.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
