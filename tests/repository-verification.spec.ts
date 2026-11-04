/** Repository authorization comes from the trusted account CLI, never from owner/repo shape or deployment equality. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'repo-verify-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

function cli(body: string): string {
  const file = join(directory, 'gh'); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file
}
const commands = (): Commands => new Commands(() => testDeployment(), {}, new AbortController().signal)

it('accepts a verified repository that differs from the deployment repository', async () => {
  const gh = cli(`if [ "$1" = api ] && [ "$2" = user ]; then echo fixture-account; exit 0; fi
if [ "$1" = api ] && [ "$2" = repos/owner/other ]; then printf 'owner/other\\ttrue\\n'; exit 0; fi
exit 1`)
  await expect(commands().verifyRepository('owner/other', { cli: gh, login: 'fixture-account' })).resolves.toBeUndefined()
})
it('rejects a different login, a renamed repository, or insufficient push access', async () => {
  const wrongLogin = cli(`if [ "$1" = api ] && [ "$2" = user ]; then echo another-account; exit 0; fi
if [ "$1" = api ] && [ "$2" = repos/owner/other ]; then printf 'owner/other\\ttrue\\n'; exit 0; fi
exit 1`)
  await expect(commands().verifyRepository('owner/other', { cli: wrongLogin, login: 'fixture-account' })).rejects.toThrow('different account')
  const renamed = cli(`if [ "$1" = api ] && [ "$2" = user ]; then echo fixture-account; exit 0; fi
if [ "$1" = api ] && [ "$2" = repos/owner/other ]; then printf 'owner/moved\\ttrue\\n'; exit 0; fi
exit 1`)
  await expect(commands().verifyRepository('owner/other', { cli: renamed, login: 'fixture-account' })).rejects.toThrow('different repository')
  const readOnly = cli(`if [ "$1" = api ] && [ "$2" = user ]; then echo fixture-account; exit 0; fi
if [ "$1" = api ] && [ "$2" = repos/owner/other ]; then printf 'owner/other\\tfalse\\n'; exit 0; fi
exit 1`)
  await expect(commands().verifyRepository('owner/other', { cli: readOnly, login: 'fixture-account' })).rejects.toThrow('cannot push')
})
