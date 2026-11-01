// Host-only fixture. No Superagent Runtime, Source, model or delivery integration.
import type { Context } from '@deepseek-ai/cordis'
import { readFile, realpath, writeFile } from 'node:fs/promises'
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
