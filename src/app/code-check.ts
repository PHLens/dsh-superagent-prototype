/** Server-owned resolution of a reviewed code-check contract into registered material and argv. */
import type { CodeCheck } from '../core/model.ts'
import type { ProjectResources, Resource } from './project-resources.ts'

/**
 * Resolves the reviewed check into registered resources and the command line it will run. Resources
 * the contract names win; otherwise exactly one explicit-purpose or type-eligible resource must
 * exist. Versions come from a bounded content capture, never from registration metadata.
 */
export function resolveCodeCheck(resources: Pick<ProjectResources, 'capture' | 'executable' | 'list'>, projectId: string, resourceIds: readonly string[], check: CodeCheck,
  interpreter: (runtime: Resource) => string): { check: CodeCheck; source: Resource; config: Resource; runtime?: Resource; runtimeVersion?: string; argv: string[] } {
  // Only metadata of resources this plan already names is read: an unrelated revoked, stale or
  // oversized resource must not stall planning, and no version changes before the final capture.
  const planned = new Set(resourceIds)
  const registered = resources.list(projectId).filter(resource => planned.has(resource.id))
  const pick = (id: string | undefined, purpose: string, types: readonly string[], exclude?: string): Resource => {
    if (id) {
      const found = registered.find(resource => resource.id === id)
      if (!found) throw new Error('Code check resource is outside the confirmed plan')
      if (found.purpose !== purpose) throw new Error(`Code check ${purpose} resource has a different purpose`)
      return found
    }
    const explicit = registered.filter(resource => resource.purpose === purpose)
    const eligible = explicit.length ? explicit : registered.filter(resource => types.includes(resource.type) && resource.id !== exclude)
    if (eligible.length !== 1) throw new Error(`Code check requires exactly one ${purpose} resource`)
    return eligible[0]!
  }
  // Every executable profile needs an owner-registered interpreter; ambient PATH is never a fallback.
  const runtimeCandidate = pick(check.runtimeResourceId, 'code-runtime', [])
  if (runtimeCandidate.type !== 'file') throw new Error('Code runtime must be a registered executable file')
  const sourceCandidate = pick(check.sourceResourceId, 'code-source', ['repository', 'directory'], runtimeCandidate?.id)
  if (sourceCandidate.type !== 'directory' && sourceCandidate.type !== 'repository') throw new Error('Code source must be a registered directory or repository')
  const configCandidate = pick(check.configResourceId, 'code-config', ['file'], runtimeCandidate?.id)
  if (configCandidate.type !== 'file') throw new Error('Code config must be a registered file')
  if (sourceCandidate.id === configCandidate.id || sourceCandidate.id === runtimeCandidate?.id || configCandidate.id === runtimeCandidate?.id) throw new Error('Code check requires distinct source, config and runtime resources')
  // Only selected material is captured: source/config content, and the interpreter's own content so
  // its binding version is the same content version the admission check revalidates.
  const source = resources.capture(projectId, sourceCandidate.id)
  const config = resources.capture(projectId, configCandidate.id)
  resources.capture(projectId, runtimeCandidate.id)
  const executable = resources.executable(projectId, runtimeCandidate.id)
  const runtime = executable.resource
  const profiles: Record<string, (path: string) => string[]> = {
    'python-smoke': path => [path, '-c', "import pathlib,sys; root=pathlib.Path(sys.argv[1]); config=pathlib.Path(sys.argv[2]); files=list(root.rglob('*.py')); [compile(p.read_text(),str(p),'exec') for p in files]; config.read_text(); print(f'validated {len(files)} source files')", '{source}', '{config}'],
    // Bounded CPU pytest. The selected tests come from the owner-registered config's testpaths.
    pytest: path => [path, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--rootdir', '{source}', '-c', '{config}'],
  }
  const build = profiles[check.profile]
  if (!build) throw new Error('Code check profile is not approved')
  // The interpreter is owner-registered and version-bound; never resolved through ambient PATH.
  return { check: { ...check, sourceResourceId: source.id, configResourceId: config.id, runtimeResourceId: runtime.id, sourceVersion: source.version, configVersion: config.version, runtimeVersion: executable.version },
    source, config, runtime, runtimeVersion: executable.version, argv: build(interpreter(runtime)) }
}
