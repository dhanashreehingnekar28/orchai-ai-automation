import { create } from 'zustand';
import type { AppData, Decision, Execution } from './api';
import type { Flow } from './engine';

type LiveState = {
  mode: 'web' | 'android';
  prompt: string;
  plan: Flow & { intent?: string } | null;
  decisions: Decision[];
  executionId: string | null;
  execution: Execution | null;
  appData: AppData | null;
  setMode: (mode: 'web' | 'android') => void;
  setPrompt: (prompt: string) => void;
  setPlan: (plan: Flow & { intent?: string } | null, decisions?: Decision[]) => void;
  setDecisions: (decisions: Decision[]) => void;
  setExecution: (execution: Execution | null) => void;
  setAppData: (data: AppData) => void;
};
const initialMode = (): 'web'|'android' => {
  if (typeof window === 'undefined') return 'web';
  return window.localStorage.getItem('orchai.mode') === 'android' ? 'android' : 'web';
};
export const useLiveState = create<LiveState>((set) => ({
  mode: initialMode(), prompt: '', plan: null, decisions: [], executionId: typeof window === 'undefined' ? null : window.sessionStorage.getItem('orchai.executionId'), execution: null, appData: null,
  setMode: (mode) => { if (typeof window !== 'undefined') window.localStorage.setItem('orchai.mode', mode); set({ mode }); }, setPrompt: (prompt) => set({ prompt }),
  setPlan: (plan, decisions = []) => set({ plan, decisions }), setDecisions: (decisions) => set({ decisions }),
  setExecution: (execution) => { if (execution?.id) window.sessionStorage.setItem('orchai.executionId', execution.id); else window.sessionStorage.removeItem('orchai.executionId'); set({ executionId: execution?.id || null, execution }); },
  setAppData: (appData) => set({ appData }),
}));
