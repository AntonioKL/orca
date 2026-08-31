import { ipcRenderer } from 'electron'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

export const agentHooksApi = {
  claudeStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:claudeStatus'),
  openClaudeStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:openClaudeStatus'),
  codexStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:codexStatus'),
  geminiStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:geminiStatus'),
  antigravityStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:antigravityStatus'),
  ampStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:ampStatus'),
  cursorStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:cursorStatus'),
  droidStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:droidStatus'),
  commandCodeStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:commandCodeStatus'),
  grokStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:grokStatus'),
  devinStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:devinStatus'),
  copilotStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:copilotStatus'),
  hermesStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:hermesStatus'),
  kimiStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:kimiStatus')
}
