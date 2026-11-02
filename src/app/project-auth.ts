/** Authentication gate for project APIs using DSH's signed browser/API admission. */
import type { IncomingMessage } from 'node:http'

/** Structural subset of the installed Host Connection service used by project routes. */
export interface ProjectConnection {
  admit(request: { readonly headers: Readonly<Record<string, string | readonly string[] | undefined>> }):
    | { readonly peer: { readonly principal: { readonly kind: string } } }
    | { readonly rejection: 401 | 403 }
}

/** Structural host context so this module stays compatible with alpha and rc DSH typings. */
export interface ProjectAuthContext { readonly connection?: ProjectConnection }

function projectConnection(context: unknown): ProjectConnection | undefined {
  if (!context || typeof context !== 'object') return undefined
  const candidate = (context as { readonly connection?: unknown }).connection
  if (!candidate || typeof candidate !== 'object' || typeof (candidate as { admit?: unknown }).admit !== 'function') return undefined
  return candidate as ProjectConnection
}

/** HTTP-safe authentication failure that never includes cookie or launch-token material. */
export class ProjectAuthError extends Error {
  constructor(readonly status: 401 | 403 | 503, message: string) {
    super(message)
    this.name = 'ProjectAuthError'
  }
}

/**
 * Admit a project request through DSH's Host Connection layer.
 *
 * `connection.admit` verifies Host/Origin and the signed browser/API cookie. The
 * returned principal is fixed by the host and cannot be supplied by request data.
 * DSH currently has one local owner principal, so project identity is `owner`.
 */
export function authenticateProjectRequest(context: unknown, request: Pick<IncomingMessage, 'headers'>): string {
  const connection = projectConnection(context)
  if (!connection) throw new ProjectAuthError(503, 'Project authentication is unavailable')
  const admission = connection.admit({ headers: request.headers })
  if ('rejection' in admission) {
    throw new ProjectAuthError(admission.rejection, admission.rejection === 401 ? 'Project authentication required' : 'Project request forbidden')
  }
  if (admission.peer.principal.kind !== 'owner') throw new ProjectAuthError(403, 'Project principal is not allowed')
  return 'owner'
}
