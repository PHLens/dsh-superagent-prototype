import { mkdtemp, readFile, writeFile, rm, realpath, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
// @ts-expect-error Standalone host launcher has no declaration file.
import { runProbe } from '../scripts/host/run-isolated-probe.mjs'

const validator = z.fromJSONSchema(JSON.parse(await readFile('scripts/host/probe-schema.json', 'utf8')))
// Fixtures verify supervision and fail-closed evidence admission only. Native
// capabilities are certified separately by the two real isolated CLI runs.
const host = `#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
if(process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
const profile=process.argv.at(-1);
const patch=JSON.parse(await readFile(join(process.env.DSH_HOME,'profiles',profile,'cordis.patch.yml'),'utf8'));
const c=patch[0].insert.find(p=>p.id==='isolated-probe').config;
const identity=join(c.stateDir,'fixture-identity.json');
if(c.sessionPhase==='create') await writeFile(identity,JSON.stringify({pid:process.pid}),{flag:'wx'});
else if(JSON.parse(await readFile(identity,'utf8')).pid===process.pid) throw Error('No process restart');
const result={profile:c.profile,dshHome:c.dshHome,stateDir:c.stateDir,workspace:c.workspace,port:c.port,hostContext:true,
 session:{id:c.profile+'-session',workspaceId:'fixture-workspace',cwd:c.workspace,realpath:c.workspace,workspacePath:c.workspace,
 permissionPreset:'workspace-write',sandboxMode:'workspace-write',approvalPolicy:'ask',eventCount:3,mappingRejected:true,pid:process.pid}};
MUTATION
await writeFile(join(c.stateDir,'result-'+c.sessionPhase+'.json'),JSON.stringify(result),{flag:'wx'});
`

async function probe(mutation = '') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'native-probe-test-'))
  try {
    const command = join(root, 'fixture-host.mjs')
    await writeFile(command, host.replace('MUTATION', mutation), { mode: 0o700 })
    const record = await runProbe({ capability: 'session', command, timeoutMs: 10000 })
    expect(validator.safeParse(record).success).toBe(true)
    expect(record.cleanup).toEqual({ processes: 'passed', directory: 'passed', port: 'passed' })
    await expect(lstat(dirname(record.context.dshHome))).rejects.toMatchObject({ code: 'ENOENT' })
    return record
  } finally {
    expect(dirname(root)).toBe(await realpath(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
}

describe('native Session probe evidence (fixture hosts)', () => {
  it('requires two processes sharing one isolated persisted context', async () => {
    const record = await probe()
    expect(record.status, record.error).toBe('passed')
    expect(record.capabilities).toEqual({ session: 'passed', skills: 'untested', web: 'untested' })
    expect(record.actual.create.session.pid).not.toBe(record.actual.reopen.session.pid)
    expect(record.actual.create.session.id).toBe(record.actual.reopen.session.id)
  })

  it.each([
    "result.session.cwd=c.stateDir",
    "result.session.realpath=c.stateDir",
    "result.session.workspacePath=c.stateDir",
    "result.session.permissionPreset='danger-full-access'",
    "result.session.sandboxMode='danger-full-access'",
    "result.session.approvalPolicy='never'",
    'result.session.mappingRejected=false',
    'result.session.eventCount=0',
    "result.session.id='other-session'",
    'delete result.session',
  ])('rejects invalid native observations: %s', async mutation => {
    const record = await probe(mutation)
    expect(record.status).toBe('failed')
    expect(record.capabilities.session).not.toBe('passed')
    expect(record.error).toBeTruthy()
  })

  it.each([
    "result.session.workspaceId='other-workspace'",
    'result.session.eventCount++',
    'result.session.pid=JSON.parse(await readFile(identity,\'utf8\')).pid',
    "result.session.permissionPreset='custom'",
  ])('rejects state changed only after restart: %s', async mutation => {
    const record = await probe(`if(c.sessionPhase==='reopen') { ${mutation}; }`)
    expect(record.status).toBe('failed')
    expect(record.capabilities.session).not.toBe('passed')
  })

  it.each(['create', 'reopen'])('rejects a nonzero %s host even with complete observations', async phase => {
    const record = await probe(`if(c.sessionPhase==='${phase}') process.exitCode=7`)
    expect(record.status).toBe('failed')
    expect(record.capabilities.session).toBe('failed')
    if (phase === 'create') expect(record.restartExecution).toBeNull()
    else expect(record.restartExecution.exitCode).toBe(7)
  })

  it('fails when the second host produces no evidence', async () => {
    const record = await probe("if(c.sessionPhase==='reopen') process.exit(0)")
    expect(record.status).toBe('failed')
    expect(record.capabilities.session).not.toBe('passed')
  })
})
