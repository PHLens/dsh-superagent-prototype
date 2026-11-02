// Host-only fixture. No Superagent Runtime, Source, model or delivery integration.
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { createServer, connect } from 'node:net'
import { join } from 'node:path'

export interface ProbeContext {
  profile: string
  dshHome: string
  stateDir: string
  workspace: string
  port: number
  outboundDisabled: true
  startedAt: string
  sessionPhase?: 'create' | 'reopen'
}

// These reads use the installed host's policy service, whose package was split
// after the repository's alpha peer floor. No application compatibility shim.
interface SandboxPolicy {
  resolve(request: { session: Session }): { mode: string; workspaceRoot: string }
}
interface ApprovalPolicy {
  overrideOf(session: Session): string | undefined
}

async function probeSession(ctx: Context, config: ProbeContext): Promise<void> {
  const id = `${config.profile}-session` as SessionId
  const identityFile = join(config.stateDir, 'session-identity.json')
  const canonical = await realpath(config.workspace)
  let session: Session
  let workspace
  let events: readonly SessionEvent[]
  if (config.sessionPhase === 'create') {
    workspace = await ctx.workspaceRegistry.create(config.workspace, 'Isolated probe')
    const captured: SessionEvent[] = []
    const stop = ctx.on('session/event', (owner, event) => {
      if (owner.id === id) captured.push(event)
    })
    try {
      session = ctx.sessions.create(id, { meta: { cwd: config.workspace } })
      ctx.permissionPresets.set(session, 'workspace-write')
    } finally { await stop() }
    const handle = await ctx.sessionPersistence.create(session.header)
    try {
      await handle.append(captured)
      await handle.flush()
      events = (await handle.read()).events
    } finally { await handle.close() }
    await workspace.attachSession(id)
    await writeFile(identityFile, JSON.stringify({ id, workspaceId: workspace.id }), { flag: 'wx', mode: 0o600 })
  } else {
    const identity = JSON.parse(await readFile(identityFile, 'utf8'))
    if (identity.id !== id || ctx.sessions.get(id)) throw new Error('Session restart identity mismatch')
    const handle = await ctx.sessionPersistence.open(id, 'write')
    try {
      const stored = await handle.read()
      events = stored.events
      if (handle.header.id !== id || handle.header.isSeeded) throw new Error('Unexpected stored Session header')
      // Re-enter through the native store with the persisted constructor metadata.
      session = ctx.sessions.create(id, {
        seed: events,
        meta: { cwd: handle.header.cwd, createdAt: handle.header.createdAt, isSeeded: false },
      })
    } finally { await handle.close() }
    workspace = ctx.workspaceRegistry.get(identity.workspaceId)
    if (!workspace || !workspace.sessionIds.includes(id)) throw new Error('Workspace membership did not persist')
  }
  const cwd = session.header.cwd
  if (!cwd) throw new Error('Session has no actual cwd')
  if (cwd !== config.workspace || await realpath(cwd) !== canonical || workspace.path !== canonical) {
    throw new Error('Session workspace mapping mismatch')
  }
  const wrongPath = join(config.stateDir, 'wrong-workspace')
  await mkdir(wrongPath, { recursive: true, mode: 0o700 })
  const wrong = await ctx.workspaceRegistry.create(wrongPath, 'Mismatch probe')
  let mappingRejected = false
  try { await wrong.attachSession(id) }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes('its cwd resolves to')) throw error
    mappingRejected = true
  }
  if (!mappingRejected || wrong.sessionIds.includes(id)) throw new Error('Host accepted a mismatched workspace')
  const policy = (ctx.get('sandboxPolicy') as unknown as SandboxPolicy).resolve({ session })
  const permissionPreset = ctx.permissionPresets.current(session)
  const approvalPolicy = (ctx.get('approval') as unknown as ApprovalPolicy).overrideOf(session)
  if (permissionPreset !== 'workspace-write' || policy.mode !== 'workspace-write' || policy.workspaceRoot !== canonical || approvalPolicy !== 'ask') {
    throw new Error('Session permission did not persist')
  }
  // Require durable knob facts: matching host defaults alone do not prove restore.
  for (const type of ['permission/preset', 'sandbox/mode', 'approval/policy']) {
    if (!events.some(event => event.type === type)) throw new Error(`Missing durable ${type}`)
  }
  await writeFile(join(config.stateDir, `result-${config.sessionPhase}.json`), JSON.stringify({
    profile: config.profile, dshHome: config.dshHome, stateDir: await realpath(config.stateDir),
    workspace: canonical, port: config.port, hostContext: !!ctx.fiber,
    session: {
      id, workspaceId: workspace.id, cwd, realpath: await realpath(cwd),
      workspacePath: workspace.path, permissionPreset, sandboxMode: policy.mode, approvalPolicy,
      eventCount: events.length, mappingRejected, pid: process.pid,
    },
  }), { flag: 'wx', mode: 0o600 })
}

export const name = 'isolated-host-probe'
export async function apply(ctx: Context, config: ProbeContext): Promise<void> {
  if (!config.outboundDisabled || process.env.DSH_PROBE_OUTBOUND_DISABLED !== '1') throw new Error('Outbound guard required')
  if (process.env.DSH_HOME !== config.dshHome || process.cwd() !== config.workspace) throw new Error('Isolation mismatch')
  if (config.port === 3082 || config.port === 53818) throw new Error('Operator port forbidden')
  const hostHome = ctx.get('dshHomePath') as unknown
  // Current RC exposes dshHomePath as a resolver function; retain the observed value.
  const resolvedHome = typeof hostHome === 'function' ? hostHome() : hostHome
  if (resolvedHome !== config.dshHome) throw new Error('Host resolved a different DSH_HOME')
  if (config.sessionPhase) {
    ctx.inject(['sessions', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'sandboxPolicy', 'approval'], async child => {
      await probeSession(child, config)
    })
    return
  }
  const stateFile = join(config.stateDir, 'roundtrip.txt')
  await writeFile(stateFile, config.profile, { flag: 'wx', mode: 0o600 })
  const stateRoundtrip = await readFile(stateFile, 'utf8') === config.profile
  const server = createServer(socket => socket.end('isolated-probe'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', resolve)
  })
  let loopbackRoundtrip = false
  try {
    loopbackRoundtrip = await new Promise<boolean>((resolve, reject) => {
      const client = connect(config.port, '127.0.0.1')
      let text = ''
      client.on('data', chunk => { text += chunk })
      client.once('error', reject)
      client.once('end', () => resolve(text === 'isolated-probe'))
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  let outboundRejected = false
  try {
    // The preload guard must reject synchronously, before any socket is opened.
    const client = connect(443, '192.0.2.1')
    client.destroy()
  } catch (error) {
    outboundRejected = (error as NodeJS.ErrnoException).code === 'PROBE_OUTBOUND_DISABLED'
  }
  if (!stateRoundtrip || !loopbackRoundtrip || !outboundRejected) throw new Error('Probe observation failed')
  await writeFile(join(config.stateDir, 'result.json'), JSON.stringify({
    profile: config.profile, dshHome: resolvedHome, stateDir: await realpath(config.stateDir),
    workspace: await realpath(config.workspace), port: config.port,
    stateRoundtrip, loopbackRoundtrip, outboundRejected, hostContext: !!ctx.fiber,
  }), { flag: 'wx', mode: 0o600 })
}
