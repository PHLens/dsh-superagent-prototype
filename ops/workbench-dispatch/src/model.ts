// External operations contracts. Do not import application Runtime or persistence.
export type DispatchStatus = 'pending' | 'ready' | 'sent' | 'accepted' | 'working' | 'blocked' | 'pr_open' | 'merged' | 'failed' | 'cancelled'
export type CapabilityState = 'passed' | 'failed' | 'unsupported' | 'untested' | 'not_applicable' | 'amber'

export interface DispatchCapability {
  id: string
  status: CapabilityState
  description: string
}

export interface DispatchTask {
  id: string
  title: string
  prompt: string
  files: { create?: string[]; modify?: string[]; test?: string[] }
  dependsOn: string[]
  capabilities: string[]
  baseBranch: 'dev'
  expectedHead: string
  acceptance: string[]
  verification: string[]
  blockedBy: string[]
}

export interface DispatchManifest {
  version: 1
  revision: string
  repository: string
  notes: string[]
  capabilities: DispatchCapability[]
  tasks: DispatchTask[]
}

export interface DispatchState {
  manifestRevision: string
  tasks: Record<string, {
    status: DispatchStatus
    messageId?: string
    ticketId?: string
    prNumber?: number
    updatedAt: string
    error?: string
  }>
}

// A send receipt is independent of task progress; an unknown send is not retry permission.
export interface DeliveryRecord {
  taskId: string
  idempotencyKey: string
  status: 'pending' | 'sent' | 'unknown' | 'gone' | 'reconciled'
  messageId?: string
  updatedAt: string
  error?: string
}
