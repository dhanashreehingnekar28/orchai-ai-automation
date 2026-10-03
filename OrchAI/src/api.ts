import type { Flow } from './engine';

export type Decision = { stepId: string; capability: string; model: string | null; provider: string; mode: string; selected: boolean; reason: string; warning?: string; candidateModels?: { name: string; accuracy: number | null; ramGB: number | null; latencyMs: number | null; battery: string | null; available: boolean; selected: boolean; rejectionReason?: string }[] };
export type LiveStep = { id: string; name: string; action: string; capability: string; input: string; output: string; status: string; error?: string };
export type Execution = {
  id: string; status: string; workflow: Flow & { intent: string }; request: string; createdAt: string; updatedAt?: string; completedAt?: string; file?: { id?: string; originalName: string; mimeType: string; size: number } | null; inputFiles?: { id?: string; originalName: string; mimeType: string; size: number }[];
  steps: LiveStep[]; decisions: Decision[]; logs: { at: string; message: string; level: string }[];
  result: Record<string, any> | null; error?: string; modelsUsed?: { capability: string; model: string; provider: string; executionMode: string; status: string }[];
  modelsUsedVerified?: boolean;
  providerTrace?: { capability?: string; provider: string; model: string | null; attempt: number; error?: string; duration?: number; fallbackUsed?: boolean }[];
  executionContext?: { stepResults?: Record<string, { input: unknown; output: unknown }> };
  fallback?: { primary?: { provider: string; model: string | null; status: string }; candidates: { provider: string; model: string | null; status: string; compatible: boolean; error?: string }[]; selected: { provider: string; model: string } | null; status?: string; reason?: string };
  confirmation?: { amount: number; currency?: string; currencySymbol?: string; merchant?: string; categories?: { category: string; total: number }[]; targetAccount: string } | null;
};
export type AppData = { workflows: any[]; history: Execution[]; expenses: any[]; provider: { configured: boolean; provider: string; model: string | null; availability?: string } };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Request failed (${response.status})`);
  return data as T;
}
const json = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
export const getHealth = () => request<{ ok: boolean; provider: AppData['provider'] }>('/api/health');
export const getAppData = () => request<AppData>('/api/state');
export const createPlan = (prompt: string, condition: string, file?: File | null, outputLanguage = 'AUTO') => request<{ workflow: Flow & { intent: string }; decisions: Decision[]; provider: AppData['provider'] }>('/api/workflows/plan', json({ prompt, condition, filename: file?.name || '', mimeType: file?.type || '', outputLanguage }));
export const routePlan = (workflowId: string, condition: string) => request<{ decisions: Decision[] }>('/api/workflows/route', json({ workflowId, condition }));
export async function createExecution(prompt: string, condition: string, files?: File[] | null, content = '', workflow?: Flow & { intent?: string }, outputLanguage = 'AUTO') {
  const body = new FormData(); body.append('prompt', prompt); body.append('condition', condition); body.append('content', content);
  body.append('outputLanguage', outputLanguage);
  if (workflow) body.append('workflow', JSON.stringify(workflow));
  for (const file of files || []) body.append('file', file, file.name);
  return request<{ execution: Execution }>('/api/executions', { method: 'POST', body });
}
export const getExecution = (id: string) => request<{ execution: Execution }>(`/api/executions/${id}`);
export const controlExecution = (id: string, action: 'pause' | 'resume' | 'stop' | 'cancel') => request<{ execution: Execution }>(`/api/executions/${id}/${action}`, { method: 'POST' });
export const confirmExpense = (id: string, amount: number, targetAccount: string) => request<{ execution: Execution; expense: any }>(`/api/executions/${id}/confirm`, json({ confirmationAmount: amount, targetAccount }));
