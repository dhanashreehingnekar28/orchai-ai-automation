import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
process.env.ORCHAI_STORAGE_DIR = join(tmpdir(), `orchai-vitest-${process.pid}`);
// Core tests exercise deterministic local fallbacks; live provider calls are validated separately.
process.env.ORCHAI_AI_PROVIDER = 'local';
const { handle, buildPlan, routeDecisions } = await import('./index.mjs');
const { generateText } = await import('./provider.mjs');
const { AIProviderRouter } = await import('./provider.mjs');
import { createStudyPack, parseReceiptText, inspectPlantImage } from './processing.mjs';

const receiptPrompt = 'Read this uploaded bill, extract the items and prices, calculate the total, categorize expenses and add to my expense tracker.';
const studyPrompt = 'Read this lecture, identify concepts, create grounded study notes and generate five quiz questions.';
let server, base;

beforeAll(async () => {
  server = createServer((request, response) => { void handle(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

async function api(path, options) {
  const response = await fetch(`${base}${path}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || response.statusText);
  return data;
}
async function runUntil(executionId, expected) {
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    const { execution } = await api(`/api/executions/${executionId}`);
    if (expected.includes(execution.status)) return execution;
    if (['failed', 'stopped'].includes(execution.status)) throw new Error(execution.error || execution.status);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${expected.join(', ')}`);
}
async function uploadExecution(prompt, file, condition = 'Normal', content = '', workflow = undefined) {
  const form = new FormData();
  form.append('prompt', prompt); form.append('condition', condition); form.append('content', content);
  for (const item of Array.isArray(file) ? file : file ? [file] : []) form.append('file', item, item.name);
  if (workflow) form.append('workflow', JSON.stringify(workflow));
  return api('/api/executions', { method: 'POST', body: form });
}
function svgReceipt({ merchant, item, amount, items, subtotal, tax, total }) {
  const lines = [merchant, 'Qty  Description                    Amount', ...(items || [`1    ${item}                        $${amount}`]), `Subtotal:                         $${subtotal}`, `Tax:                               $${tax}`, `TOTAL:                             $${total}`];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700"><rect width="100%" height="100%" fill="white"/>${lines.map((line, i) => `<text x="48" y="${70 + i * 80}" font-family="Arial" font-size="34" fill="#111">${line.replaceAll('&','&amp;').replaceAll('<','&lt;')}</text>`).join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe('input-grounded processing', () => {
  it('routes a recoverable Groq failure through the configured Gemini fallback and records both attempts', async () => {
    const priorGeminiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-only-gemini-placeholder';
    const attempts = [];
    try {
      const router = new AIProviderRouter();
      const result = await router.execute(async (provider, _adapter, model) => {
        attempts.push(provider);
        if (provider === 'groq') throw new Error('REAL EXECUTION UNAVAILABLE: Groq returned HTTP 429: temporary rate limit');
        return { text: 'recovered', model, provider: 'Google Gemini' };
      }, { provider: 'groq', model: 'openai/gpt-oss-120b', capability: 'text' });
      expect(attempts).toEqual(['groq', 'gemini']);
      expect(result.text).toBe('recovered');
      expect(result.providerTrace).toHaveLength(2);
      expect(result.providerTrace[0]).toMatchObject({ provider: 'Groq', attempt: 1, fallbackUsed: true });
      expect(result.providerTrace[1]).toMatchObject({ provider: 'Google Gemini', attempt: 2, fallbackUsed: true });
    } finally {
      if (priorGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorGeminiKey;
    }
  });

  it('does not route ordinary application bugs through Gemini', async () => {
    const priorGeminiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-only-gemini-placeholder';
    const attempts = [];
    try {
      const router = new AIProviderRouter();
      await expect(router.execute(async provider => { attempts.push(provider); throw new TypeError('application bug'); }, { provider: 'groq', model: 'openai/gpt-oss-120b' })).rejects.toThrow('application bug');
      expect(attempts).toEqual(['groq']);
    } finally {
      if (priorGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorGeminiKey;
    }
  });
  it('extracts new receipt items and totals but refuses to invent AI categories when no provider is configured', async () => {
    const sampleBytes = await svgReceipt({ merchant: 'DAILY GRIND', items: ['1 Medium Latte $5.25', '1 Croissant $4.50', '1 Avocado Toast $8.00'], subtotal: '17.75', tax: '1.29', total: '19.04' });
    const generated = await api('/api/workflows/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: receiptPrompt, filename: 'daily-grind.png', mimeType: 'image/png' }) });
    const editedPlan = { ...generated.workflow, steps: generated.workflow.steps.map((step, index) => index === 1 ? { ...step, name: 'Extract my receipt line items' } : step) };
    const first = await uploadExecution(receiptPrompt, new File([sampleBytes], 'daily-grind.png', { type: 'image/png' }), 'Normal', '', editedPlan);
    const firstResult = await runUntil(first.execution.id, ['failed']);
    const firstReceipt = firstResult.result.receipt;
    expect(firstResult.workflow.steps[1].name).toBe('Extract my receipt line items');
    expect(firstReceipt.merchant).toMatch(/DAILY GRIND/i);
    expect(firstReceipt.items.map(item => item.description)).toEqual(expect.arrayContaining(['Medium Latte', 'Croissant', 'Avocado Toast']));
    expect(firstReceipt.lineItemsTotal).toBe(17.75);
    expect(firstReceipt.calculatedTotal).toBe(19.04);
    expect(firstReceipt.discrepancyFlag).toBe('totals match');
    expect(firstReceipt.items.every(item => item.category === 'Uncategorized')).toBe(true);
    expect(firstResult.error).toMatch(/semantic receipt categorization requires/i);
    expect(firstResult.steps.find(step => step.action === 'categorize').status).toBe('failed');
    expect(firstResult.steps.find(step => step.action === 'confirm_expense').status).toBe('blocked');
    const blockedConfirmation = await fetch(`${base}/api/executions/${firstResult.id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmationAmount: firstReceipt.calculatedTotal, targetAccount: 'Personal Expenses' }) });
    expect(blockedConfirmation.status).toBe(409);
    expect((await api('/api/state')).expenses).toHaveLength(0);

    const secondBytes = await svgReceipt({ merchant: 'Northside Bookshop', item: 'Notebook', amount: '8.40', subtotal: '8.40', tax: '0.67', total: '9.07' });
    const second = await uploadExecution(receiptPrompt, new File([secondBytes], 'northside.png', { type: 'image/png' }));
    const secondResult = await runUntil(second.execution.id, ['failed']);
    expect(secondResult.result.receipt.merchant).toMatch(/Northside/i);
    expect(secondResult.result.receipt.items[0].description).toMatch(/Notebook/i);
    expect(secondResult.result.receipt.calculatedTotal).toBe(9.07);
    expect(secondResult.result.receipt.calculatedTotal).not.toBe(firstReceipt.calculatedTotal);
  }, 120_000);

  it('routes text-only expense lists through extraction and semantic categorization steps', async () => {
    const prompt = 'Categorize these expenses: French fries ₹120, notebook ₹80, bus ticket ₹40.';
    const planned = await api('/api/workflows/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
    expect(planned.workflow.intent).toBe('expense');
    expect(planned.workflow.steps.map(step => step.action)).toEqual(['extract_receipt', 'calculate_total', 'categorize']);
    const created = await uploadExecution(prompt, null);
    const result = await runUntil(created.execution.id, ['failed']);
    expect(result.result, JSON.stringify({ error: result.error, logs: result.logs })).not.toBeNull();
    expect(result.result.receipt.items.map(item => [item.description, item.amount])).toEqual([
      ['French fries', 120], ['notebook', 80], ['bus ticket', 40],
    ]);
    expect(result.result.receipt.calculatedTotal).toBe(240);
    expect(result.steps.find(step => step.action === 'categorize').status).toBe('failed');
  });

  it('creates different study packs from different lecture texts with five questions each', () => {
    const sourceA = 'Photosynthesis converts light into stored chemical energy in plants. Chlorophyll absorbs red and blue wavelengths inside chloroplasts. Carbon dioxide and water are transformed into glucose and oxygen. The Calvin cycle fixes carbon using energy carriers. Environmental light intensity changes the rate of photosynthesis.';
    const sourceB = 'Plate tectonics describes how rigid lithospheric plates move over the mantle. Convergent boundaries create mountains and subduction zones. Divergent boundaries form new oceanic crust at mid-ocean ridges. Transform faults slide horizontally and can generate earthquakes. Seafloor spreading provides evidence for continental drift.';
    const packA = createStudyPack(sourceA), packB = createStudyPack(sourceB);
    expect(packA.quizQuestions).toHaveLength(5); expect(packB.quizQuestions).toHaveLength(5);
    expect(packA.summary).not.toBe(packB.summary);
    expect(packA.keyConcepts.map(item => item.name)).not.toEqual(packB.keyConcepts.map(item => item.name));
  });

  it('keeps plant assessment image-dependent and communicates its low confidence', async () => {
    const green = await sharp({ create: { width: 400, height: 500, channels: 3, background: { r: 20, g: 145, b: 40 } } }).png().toBuffer();
    const mottled = await sharp({ create: { width: 400, height: 500, channels: 3, background: { r: 145, g: 94, b: 35 } } }).png().toBuffer();
    const a = await inspectPlantImage(green), b = await inspectPlantImage(mottled);
    expect(a.observation).not.toBe(b.observation);
    expect(a.confidence).toBeLessThan(0.55); expect(b.confidence).toBeLessThan(0.55);
    expect(a.limitations).toMatch(/does not identify|does not diagnose/i);
  });

  it('runs two uploaded plant photos through the actual API and retains uncertainty', async () => {
    const healthy = await sharp({ create: { width: 480, height: 480, channels: 3, background: { r: 25, g: 155, b: 45 } } }).png().toBuffer();
    const discolored = await sharp({ create: { width: 480, height: 480, channels: 3, background: { r: 154, g: 96, b: 37 } } }).png().toBuffer();
    const prompt = 'Analyze this plant photo, describe visible symptoms and suggest a cautious care plan.';
    const first = await uploadExecution(prompt, new File([healthy], 'green-leaf.png', { type: 'image/png' }));
    const firstResult = await runUntil(first.execution.id, ['completed']);
    const second = await uploadExecution(prompt, new File([discolored], 'discolored-leaf.png', { type: 'image/png' }));
    const secondResult = await runUntil(second.execution.id, ['completed']);
    expect(firstResult.result.plant.observation).not.toBe(secondResult.result.plant.observation);
    expect(firstResult.result.plant.confidencePercent).toBeLessThan(55);
    expect(secondResult.result.plant.confidencePercent).toBeLessThan(55);
  }, 30_000);

  it('routes offline steps to installed local components and rejects unrelated requests', async () => {
    const plan = buildPlan('Analyze this receipt image and total the expenses.', { mimeType: 'image/png', filename: 'receipt.png' });
    const decisions = routeDecisions(plan, 'Offline');
    const receiptDecision = decisions.find(item => /OCR/i.test(item.model));
    expect(receiptDecision?.mode).toBe('LOCAL');
    expect(receiptDecision.candidateModels.some(model => model.name === 'Tesseract.js English OCR' && model.selected)).toBe(true);
    const lowRam = routeDecisions(plan, 'Low RAM').find(item => /OCR/i.test(item.model));
    expect(lowRam.candidateModels.find(model => model.name === 'Tesseract.js English OCR')).toMatchObject({ available: true, selected: true });
    const audioPlan = buildPlan(studyPrompt, { mimeType: 'audio/mpeg', filename: 'lecture.mp3' });
    expect(audioPlan.steps.some(step => step.action === 'transcribe')).toBe(true);
    expect(routeDecisions(audioPlan, 'Offline').find(item => item.stepId === 'transcribe').mode).toBe('ASK');
    expect(buildPlan('Explain machine learning in five bullet points').intent).toBe('general');
  });

  it('changes language-model routing for all four device profiles without making provider calls', () => {
    const previousProvider = process.env.ORCHAI_AI_PROVIDER, previousKey = process.env.GEMINI_API_KEY, previousModel = process.env.ORCHAI_AI_MODEL;
    process.env.ORCHAI_AI_PROVIDER = 'gemini'; process.env.GEMINI_API_KEY = 'test-only-placeholder'; process.env.ORCHAI_AI_MODEL = 'gemini-3.8-flash';
    try {
      const plan = buildPlan('Explain what machine learning is in five bullet points.');
      const getDecision = profile => routeDecisions(plan, profile)[0];
      expect(getDecision('Normal')).toMatchObject({ mode: 'CLOUD', selected: true, model: 'gemini-3.8-flash' });
      expect(getDecision('Offline')).toMatchObject({ mode: 'ASK', selected: false });
      expect(getDecision('Low RAM')).toMatchObject({ mode: 'CLOUD', selected: true, model: 'gemini-3.5-flash-lite' });
      expect(getDecision('Low Battery')).toMatchObject({ mode: 'CLOUD', selected: true, model: 'gemini-3.5-flash-lite' });
      expect(getDecision('Low Battery').reason).toMatch(/Flash-Lite.*one provider call/i);
      expect(getDecision('Offline').reason).toMatch(/blocks all cloud calls/i);
    } finally {
      if (previousProvider === undefined) delete process.env.ORCHAI_AI_PROVIDER; else process.env.ORCHAI_AI_PROVIDER = previousProvider;
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.ORCHAI_AI_MODEL; else process.env.ORCHAI_AI_MODEL = previousModel;
    }
  });

  it('never uses GOOGLE_API_KEY as a Gemini fallback', async () => {
    const previousProvider = process.env.ORCHAI_AI_PROVIDER, previousGeminiKey = process.env.GEMINI_API_KEY, previousGoogleKey = process.env.GOOGLE_API_KEY;
    process.env.ORCHAI_AI_PROVIDER = 'gemini';
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-only-placeholder';
    try {
      await expect(generateText('This must not make a request.')).rejects.toThrow(/gemini provider is not configured/i);
    } finally {
      if (previousProvider === undefined) delete process.env.ORCHAI_AI_PROVIDER; else process.env.ORCHAI_AI_PROVIDER = previousProvider;
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousGeminiKey;
      if (previousGoogleKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = previousGoogleKey;
    }
  });

  it('merges multiple uploaded PDFs with a local deterministic tool and records no model use', async () => {
    const first = await PDFDocument.create(); first.addPage([300, 400]);
    const second = await PDFDocument.create(); second.addPage([500, 700]); second.addPage([600, 800]);
    const files = [new File([await first.save()], 'first.pdf', { type: 'application/pdf' }), new File([await second.save()], 'second.pdf', { type: 'application/pdf' })];
    const created = await uploadExecution('Combine these two PDFs into one PDF.', files);
    const result = await runUntil(created.execution.id, ['completed']);
    expect(result.workflow.intent).toBe('pdf_merge');
    expect(result.result.pdfMerge).toMatchObject({ inputCount: 2, pageCount: 3 });
    expect(result.modelsUsed).toEqual(expect.arrayContaining([expect.objectContaining({ capability: 'PDF merge', model: null, provider: 'Local PDF processor', executionMode: 'LOCAL', status: 'USED' })]));
    const download = await fetch(`${base}${result.result.pdfMerge.downloadUrl}`);
    expect(download.status).toBe(200);
    expect((await PDFDocument.load(new Uint8Array(await download.arrayBuffer()))).getPageCount()).toBe(3);
  }, 30_000);

  it('executes a pasted lecture through the API, saves it, and returns a dynamic study pack', async () => {
    const content = 'Quantum mechanics uses wave functions to describe the state of particles. Measurement produces outcomes according to probability amplitudes. The uncertainty principle limits simultaneous knowledge of position and momentum. Superposition allows a system to combine possible states until measurement. Entanglement correlates outcomes for distant quantum particles.';
    const created = await uploadExecution(studyPrompt, null, 'Offline', content);
    const result = await runUntil(created.execution.id, ['completed']);
    expect(result.result.studyPack.quizQuestions).toHaveLength(5);
    expect(result.result.studyPack.summary).toContain('quantum');
    const data = await api('/api/state');
    expect(data.history.some(item => item.id === result.id && item.status === 'completed')).toBe(true);
  }, 30_000);

  it('reroutes a generated plan when the device goes offline', async () => {
    const created = await api('/api/workflows/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Analyze this photo of my plant and identify visible issues.', filename: 'plant.png', mimeType: 'image/png', condition: 'Normal' }) });
    const offline = await api('/api/workflows/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: created.workflow.id, condition: 'Offline' }) });
    expect(offline.decisions.find(item => item.stepId === 'assess').mode).toBe('LOCAL');
  });
});
