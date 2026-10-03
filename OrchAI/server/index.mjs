import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile, rename, readFile, stat, unlink } from 'node:fs/promises';
import { extname, join, resolve, basename, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { createStudyPack, inspectPlantImage, parseReceiptText, receiptFromProvider, recognizeImage } from './processing.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const isMainServer = Boolean(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href);
function loadEnvironment() {
  const filename = join(ROOT, '.env');
  const loaded = new Map();
  if (!existsSync(filename)) return { filename, loaded };
  for (const line of readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    loaded.set(match[1], value);
    // The project's root .env is authoritative for provider credentials and routing.
    if ((isMainServer && ['GEMINI_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'ORCHAI_AI_PROVIDER', 'ORCHAI_AI_MODEL', 'ORCHAI_TRANSCRIPTION_MODEL', 'GROQ_VISION_MODEL', 'GROQ_TRANSCRIPTION_MODEL'].includes(match[1])) || !process.env[match[1]]) process.env[match[1]] = value;
  }
  return { filename, loaded };
}
const environment = loadEnvironment();
const { analyzePlantImage, analyzeReceiptImage, analyzeReceiptText, generateStudyPack, generateText, generateTextWithFiles, generateTextWithProvider, extractPdfWithGemini, categorizeReceiptItems, providerStatus, transcribeAudio, testProviderConnection, classifyWorkflowIntent } = await import('./provider.mjs');
const fingerprint = value => value ? createHash('sha256').update(value, 'utf8').digest('hex') : null;
function selectedKeyInfo() {
  const provider = (process.env.ORCHAI_AI_PROVIDER || 'gemini').toLowerCase();
  const name = provider === 'groq' ? 'GROQ_API_KEY' : provider === 'gemini' ? 'GEMINI_API_KEY' : provider === 'xai' ? 'XAI_API_KEY' : 'ORCHAI_AI_API_KEY';
  const value = process.env[name] || '';
  return { provider, model: providerStatus().model || process.env.ORCHAI_AI_MODEL || '(unset)', keyName: name, value, keySource: environment.loaded.has(name) ? environment.filename : 'process environment / unavailable' };
}
const providerKeyDiagnostic = () => {
  const { provider, model, keyName, value, keySource } = selectedKeyInfo();
  return {
  envFile: environment.filename,
  envFileExists: existsSync(environment.filename),
    provider, model, keyName, keyPresent: Boolean(value), keyLength: value.length,
    keyFingerprint: fingerprint(value), keySource,
  };
};
function logProviderDiagnostic() {
  const diagnostic = providerKeyDiagnostic();
  console.log(`AI_PROVIDER=${diagnostic.provider}`);
  console.log(`AI_MODEL=${diagnostic.model}`);
  console.log(`AI_KEY_PRESENT=${diagnostic.keyPresent}`);
  console.log(`AI_KEY_LENGTH=${diagnostic.keyLength}`);
  console.log(`AI_KEY_FINGERPRINT=${diagnostic.keyFingerprint || '(absent)'}`);
  console.log(`AI_KEY_SOURCE=${diagnostic.keySource}`);
}

const STORE = resolve(process.env.ORCHAI_STORAGE_DIR || join(ROOT, 'storage', 'runtime'));
const UPLOADS = join(STORE, 'uploads');
const DB_FILE = join(STORE, 'orchai-state.json');
const PORT = Number(process.env.ORCHAI_PORT || 4174);
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
mkdirSync(UPLOADS, { recursive: true });

const freshState = () => ({ version: 1, workflows: [], executions: [], expenses: [] });
let state = freshState();
try { state = { ...freshState(), ...JSON.parse(readFileSync(DB_FILE, 'utf8')) }; } catch { /* first start creates a new local store */ }
let writeQueue = Promise.resolve();
async function saveState() {
  const snapshot = JSON.stringify(state, null, 2);
  const write = writeQueue.catch(() => {}).then(async () => {
    const temporary = `${DB_FILE}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, snapshot, 'utf8');
    try { await rename(temporary, DB_FILE); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EEXIST'].includes(error.code)) throw error;
      try { await writeFile(DB_FILE, snapshot, 'utf8'); }
      finally { await unlink(temporary).catch(() => {}); }
    }
  });
  writeQueue = write;
  await write;
}
const now = () => new Date().toISOString();
const uuid = () => randomUUID();
function appendLog(execution, message, level = 'info') {
  execution.logs.push({ at: now(), step: execution.currentStepIndex, message, level });
  execution.updatedAt = now();
}
function patchStep(execution, index, patch) { execution.steps[index] = { ...execution.steps[index], ...patch, updatedAt: now() }; execution.currentStepIndex = index; }
function inferIntent(prompt = '', mimeType = '', filename = '') {
  const q = prompt.toLowerCase();
  const hasDocumentInput = mimeType.startsWith('image/') || mimeType === 'application/pdf' || /\.(?:png|jpe?g|webp|pdf)$/i.test(filename);
  const explicitExpenseTask = /\b(?:categorize|categorise|classify)\b.{0,60}\bexpenses?\b|\bexpenses?\s*:\s*[^\n]*(?:₹|\$|€|£|\binr\b|\brs\.?\s*\d)/i.test(prompt);
  if (explicitExpenseTask) return 'expense';
  if (hasDocumentInput && /receipt|bill|invoice|expense tracker|categor(?:ize|ise).*expense|handwritten bill/.test(q)) return 'expense';
  if (/lecture|study pack|quiz|transcrib|study notes|record a lecture/.test(q)) return 'study';
  if (hasDocumentInput && /\b(?:analy[sz]e|inspect|diagnos|assess)\b/.test(q) && /plant|leaf|leaves|disease|care plan/.test(q)) return 'plant';
  if (/\b(?:combine|merge|join)\b/.test(q) && /pdf/.test(`${q} ${filename.toLowerCase()}`)) return 'pdf_merge';
  if (/open (?:the )?notes? app|create (?:a )?new note|android app/.test(q)) return 'android';
  if (/lecture|study pack|quiz|transcrib|study notes|record a lecture/.test(q)) return 'study';
  if (/\.(?:wav|mp3|m4a|ogg|webm|mp4)$/.test(filename.toLowerCase()) || mimeType.startsWith('audio/') || mimeType.startsWith('video/')) return 'study';
  if (mimeType.startsWith('image/')) return /plant|leaf|garden|crop/.test(q) ? 'plant' : /bill|receipt|expense|invoice/.test(q) ? 'expense' : null;
  if (hasDocumentInput && /\b(?:analy[sz]e|inspect|diagnos|assess)\b/.test(q) && /plant|leaf|garden|crop/.test(q)) return 'plant';
  if (hasDocumentInput && /bill|receipt|expense|invoice/.test(q)) return 'expense';
  if (/lecture|study|notes|quiz|transcrib/.test(q)) return 'study';
  return 'general';
}
function createStep(id, name, action, capability, input, output, type = 'ai') { return { id, name, action, capability, input, output, minAccuracy: type === 'ai' ? 85 : 0, type, status: 'queued' }; }
export function buildPlan(prompt, { mimeType = '', filename = '', intent: plannedIntent = null, planningEvent = null } = {}) {
  const validIntents = ['expense', 'study', 'plant', 'pdf_merge', 'android', 'general'];
  const intent = validIntents.includes(plannedIntent) ? plannedIntent : inferIntent(prompt, mimeType, filename);
  if (intent === 'android') throw new HttpError(503, 'UNAVAILABLE\nThis action is not supported on this device. No note was created.');
  const id = `${intent}-${uuid()}`;
  let steps;
  if (intent === 'expense') {
    const includesAction = /add|save|track|record|expense tracker/.test(prompt.toLowerCase());
    const hasUpload = Boolean(mimeType || filename);
    steps = [...(hasUpload ? [createStep('capture', 'Read uploaded bill', 'capture', 'image input', 'Receipt or bill image', 'Image ready', 'trigger')] : []), createStep('extract', hasUpload ? 'Extract receipt details' : 'Read expense items', 'extract_receipt', hasUpload ? 'vision + OCR · structured extraction' : 'text expense extraction', hasUpload ? 'Bill image' : 'Provided expense list', 'Merchant, items, prices, tax'), createStep('calculate', 'Calculate and compare totals', 'calculate_total', 'deterministic calculation', 'Extracted line items', 'Calculated total', 'logic'), createStep('categorize', 'Categorize expense items', 'categorize', 'expense classification', 'Item descriptions', 'Category breakdown', 'logic')];
    if (includesAction) steps.push(createStep('add-expense', 'Add to expense tracker', 'confirm_expense', 'Android action · explicit confirmation', 'Confirmed amount and categories', 'Awaiting your confirmation', 'action'));
  } else if (intent === 'study') {
    const isAudio = mimeType.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|webm|mp4)$/i.test(filename);
    steps = [createStep('source', 'Read lecture source', 'read_source', isAudio ? 'speech-to-text' : 'document / text extraction', isAudio ? 'Audio recording' : 'Text, PDF, or transcript', 'Source content', 'trigger'), ...(isAudio ? [createStep('transcribe', 'Transcribe recording', 'transcribe', 'speech-to-text', 'Audio file', 'Transcript')] : []), createStep('concepts', 'Identify key concepts', 'concepts', 'text analysis', 'Lecture source', 'Five important concepts'), createStep('notes', 'Create study notes', 'notes', 'summarization', 'Key concepts + source', 'Source-grounded notes'), createStep('quiz', 'Generate five quiz questions', 'quiz', 'question generation', 'Study notes', 'Exactly five questions')];
  } else if (intent === 'pdf_merge') {
    steps = [createStep('pdf-inputs', 'Validate PDF inputs', 'validate_pdf_inputs', 'PDF input validation', 'Two or more PDF files', 'Valid PDF inputs', 'logic'), createStep('merge-pdfs', 'Merge PDF pages', 'merge_pdfs', 'local PDF merge', 'Validated PDF inputs', 'Merged PDF file', 'logic')];
  } else if (intent === 'plant') {
    steps = [createStep('capture-plant', 'Read plant photo', 'capture', 'image input', 'Plant photo', 'Image ready', 'trigger'), createStep('quality', 'Check photo quality', 'plant_quality', 'image quality analysis', 'Plant photo', 'Resolution and visual signal', 'logic'), createStep('assess', 'Assess visible condition', 'plant_assessment', 'plant vision', 'Image-derived signals', 'Cautious model assessment'), createStep('symptoms', 'Explain visible symptoms', 'plant_symptoms', 'image-grounded reasoning', 'Observed image signals', 'Possible issue + uncertainty'), createStep('treatment', 'Retrieve treatment guidance', 'plant_treatment', 'treatment knowledge retrieval', 'Possible issue', 'General treatment guidance'), createStep('care-plan', 'Create tailored care plan', 'care_plan', 'care planning', 'Image signals + guidance', 'Recommended next steps')];
  } else {
    steps = [createStep('understand', 'Understand your request', 'general_task', 'natural-language reasoning', mimeType ? `${mimeType} input` : 'Your request', 'Task result')];
  }
  return { id, title: { expense: 'Receipt analysis', study: 'Lecture study pack', plant: 'Plant image analysis', pdf_merge: 'Merge PDF files', general: prompt.trim().slice(0, 70) || 'Natural language task' }[intent], domain: { expense: 'FINANCE', study: 'EDUCATION', plant: 'VISUAL ANALYSIS', pdf_merge: 'FILE PROCESSING', general: 'GENERAL' }[intent], intent, request: prompt.trim(), generatedAt: now(), steps, inputRequirements: { expense: 'image/*', plant: 'image/*', study: 'audio/*, application/pdf, text/*', pdf_merge: 'Two or more PDF files' }[intent] || 'As required by task', isGeneratedFromCurrentRequest: true, planningEvent };
}

async function planWorkflow(prompt, { mimeType = '', filename = '', condition = 'Normal' } = {}) {
  let planningEvent = null, plannedIntent = null;
  if (condition !== 'Offline' && providerStatus().configured) {
    const classified = await classifyWorkflowIntent(prompt, { mimeType, filename });
    plannedIntent = classified.intent;
    planningEvent = { capability: 'workflow planning', model: classified.model, provider: classified.provider, executionMode: 'REAL', status: 'USED', completedAt: now(), providerTrace: classified.providerTrace };
  }
  // Preserve explicit finance intent when the model's planner labels a clear text-only expense list as general.
  if (inferIntent(prompt, mimeType, filename) === 'expense') plannedIntent = 'expense';
  return buildPlan(prompt, { mimeType, filename, intent: plannedIntent, planningEvent });
}

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function asFlow(plan) { return { ...plan, description: plan.request || plan.title, prompt: plan.request, eta: 'Live execution', steps: plan.steps.map(s => ({ id: s.id, name: s.name, input: s.input, output: s.output, capability: s.capability, min: s.minAccuracy ?? s.min ?? 0, kind: s.type === 'logic' ? 'logic' : s.type === 'action' ? 'android' : s.type === 'trigger' ? 'trigger' : s.kind, action: s.action })) }; }

export function routeDecisions(plan, condition = 'Normal') {
  const provider = providerStatus();
  const configured = provider.configured;
  const availableRam = condition === 'Low RAM' ? 1.2 : 4.8;
  return plan.steps.filter(step => step.capability).map(step => {
    const audio = step.action === 'transcribe';
    const vision = ['extract_receipt', 'plant_assessment'].includes(step.action);
    const cloudAvailable = condition !== 'Offline' && configured && (!(audio || vision) || (audio ? provider.supportsTranscription : provider.supportsVision));
    const base = { stepId: step.id, capability: step.capability };
    if (step.action === 'general_task') {
      const lightweight = ['Low RAM', 'Low Battery'].includes(condition) && provider.providerId === 'gemini';
      const model = lightweight ? 'gemini-3.5-flash-lite' : providerStatus().model;
      const available = condition !== 'Offline' && configured;
      const selected = available;
      return { ...base, model: selected ? model : null, provider: selected ? providerStatus().provider : 'Unavailable', mode: selected ? 'CLOUD' : 'ASK', selected, reason: condition === 'Offline' ? 'Offline profile blocks all cloud calls; no local language model is installed.' : lightweight ? `${condition} profile selected Gemini Flash-Lite and limits text generation to one provider call.` : selected ? `${condition} profile; one configured provider call will handle this task.` : 'No configured provider is available for natural-language generation.', candidateModels: [{ name: model || 'Configured language model', accuracy: null, ramGB: null, latencyMs: null, battery: null, available: selected, selected, rejectionReason: selected ? 'Configured candidate; actual availability is confirmed by its execution request.' : 'Provider is not configured or cloud use is blocked.' }] };
    }
    if (step.action === 'categorize') {
      const useCloud = condition !== 'Offline' && configured;
      return { ...base, model: useCloud ? providerStatus().model : null, provider: useCloud ? providerStatus().provider : 'Unavailable', mode: useCloud ? 'CLOUD' : 'ASK', selected: useCloud, reason: useCloud ? 'Semantic item categorization is delegated to the configured AI provider; arithmetic remains deterministic.' : 'No online AI provider is available; category labels will remain explicitly unavailable.', candidateModels: [{ name: providerStatus().model || 'Configured text model', accuracy: null, ramGB: null, latencyMs: null, battery: null, available: useCloud, selected: useCloud }] };
    }
    if (['concepts', 'notes', 'quiz'].includes(step.action)) {
      const useCloud = condition !== 'Offline' && configured;
      return { ...base, model: useCloud ? providerStatus().model : 'Local text analysis · no generative model', provider: useCloud ? providerStatus().provider : 'Local', mode: useCloud ? 'CLOUD' : 'LOCAL', selected: true, reason: useCloud ? `Configured ${providerStatus().provider} text model will generate the study pack in one request under ${condition}.` : `${condition} profile selects the installed source-grounded local study-pack pipeline; cloud is not called.`, candidateModels: [{ name: providerStatus().model || 'Configured text model', accuracy: null, ramGB: null, latencyMs: null, battery: null, available: useCloud, selected: useCloud, rejectionReason: useCloud ? 'Configured candidate; actual availability is confirmed by its execution request.' : 'Cloud generation is not selected for this profile.' }, { name: 'Local extractive study-pack pipeline', accuracy: null, ramGB: null, latencyMs: null, battery: null, available: true, selected: !useCloud }] };
    }
    if (step.action === 'capture' || step.action === 'read_source' || step.type === 'trigger' || step.kind === 'trigger') return { ...base, model: 'User-provided input', provider: 'OrchAI input adapter', mode: 'INPUT', selected: true, reason: 'This step accepts the file or text the user supplied.', candidateModels: [{ name: 'User input adapter', accuracy: null, ramGB: null, latencyMs: null, battery: null, available: true, selected: true }] };
    if (step.action === 'confirm_expense' || step.kind === 'android' || step.type === 'action') return { ...base, model: 'Confirmed expense tracker action', provider: 'Local OrchAI store', mode: 'ANDROID', selected: true, reason: 'A user confirmation is required before writing an expense record.', candidateModels: [{ name: 'Expense tracker action', accuracy: null, ramGB: null, latencyMs: null, battery: null, available: true, selected: true }] };
    if (['calculate_total', 'categorize', 'plant_quality', 'plant_symptoms', 'plant_treatment', 'care_plan'].includes(step.action) || step.kind === 'logic' || step.type === 'logic') return { ...base, model: 'Local deterministic processing', provider: 'Local', mode: 'LOCAL', selected: true, reason: 'This step runs locally on data derived from the uploaded input.', candidateModels: [{ name: 'Deterministic local component', accuracy: null, ramGB: null, latencyMs: null, battery: null, available: true, selected: true }] };
    const providerName = providerStatus().model || 'Configured vision / language model';
    const candidateModels = [];
    if (vision && step.action === 'extract_receipt') {
      const useCloud = cloudAvailable && condition === 'Normal';
      candidateModels.push({ name: useCloud ? provider.visionModel : providerName, accuracy: null, ramGB: null, latencyMs: null, battery: null, available: cloudAvailable, selected: useCloud, rejectionReason: useCloud ? undefined : `${condition} profile prefers the installed local OCR pipeline.` });
      candidateModels.push({ name: 'Tesseract.js English OCR', accuracy: null, ramGB: null, latencyMs: null, battery: null, available: true, selected: !useCloud });
      return { ...base, model: useCloud ? provider.visionModel : 'Tesseract.js English OCR', provider: useCloud ? provider.provider : 'Local', mode: useCloud ? 'CLOUD' : 'LOCAL', selected: true, reason: useCloud ? `Configured ${provider.provider} vision provider selected under the Normal profile.` : `${condition} profile selects installed local OCR; cloud vision is not called.`, warning: 'OCR output is derived from this image; review recognition uncertainty.', candidateModels };
    }
    if (vision && step.action === 'plant_assessment') {
      const useCloud = cloudAvailable && condition === 'Normal';
      candidateModels.push({ name: useCloud ? provider.visionModel : providerName, accuracy: null, ramGB: null, latencyMs: null, battery: null, available: cloudAvailable, selected: useCloud, rejectionReason: useCloud ? undefined : `${condition} profile favors lightweight local analysis.` });
      candidateModels.push({ name: 'Local pixel-color analysis', accuracy: null, ramGB: null, latencyMs: null, battery: null, available: true, selected: !useCloud, rejectionReason: 'Low-confidence color signals only; not a diagnosis.' });
      return { ...base, model: useCloud ? provider.visionModel : 'Sharp pixel-color analysis', provider: useCloud ? provider.provider : 'Local', mode: useCloud ? 'CLOUD' : 'LOCAL', selected: true, reason: useCloud ? `Configured ${provider.provider} vision provider selected under the Normal profile.` : `${condition} profile selects lightweight local pixel analysis; no cloud call is made.`, warning: useCloud ? undefined : 'Non-diagnostic color heuristics only; confidence remains low.', candidateModels };
    }
    if (audio) {
      const transcriptionModel = provider.transcriptionModel || 'Configured speech-to-text model';
      candidateModels.push({ name: transcriptionModel, accuracy: null, ramGB: null, latencyMs: null, battery: null, available: cloudAvailable, selected: cloudAvailable });
      return { ...base, model: cloudAvailable ? transcriptionModel : null, provider: cloudAvailable ? provider.provider : 'Unavailable', mode: cloudAvailable ? 'CLOUD' : 'ASK', selected: cloudAvailable, reason: cloudAvailable ? `Configured ${provider.provider} transcription provider is available and network is enabled.` : 'No local speech model or configured transcription provider is available.', candidateModels };
    }
    candidateModels.push({ name: providerName, accuracy: null, ramGB: null, latencyMs: null, battery: null, available: cloudAvailable, selected: cloudAvailable });
    return { ...base, model: cloudAvailable ? providerName : null, provider: cloudAvailable ? providerStatus().provider : 'Unavailable', mode: cloudAvailable ? 'CLOUD' : 'ASK', selected: cloudAvailable, reason: cloudAvailable ? `Configured language model candidate under ${condition} profile.` : 'No compatible language model is configured or cloud is blocked.', availableRamGB: availableRam, candidateModels };
  });
}

async function extractStudySource(execution, file, textInput) {
  if (!file) {
    if ((textInput || '').trim().length >= 25) return { text: textInput.trim(), transcript: textInput.trim(), sourceType: 'pasted text', provider: 'User-provided text' };
    throw new HttpError(422, 'Upload a .txt or .pdf lecture, paste lecture text, or configure a speech-to-text provider and upload audio.');
  }
  const ext = extname(file.originalName).toLowerCase();
  if (['.txt', '.md', '.csv', '.json'].includes(ext) || file.mimeType.startsWith('text/')) {
    const text = (await readFile(file.path, 'utf8')).replace(/\u0000/g, '').trim();
    if (text.length < 25) throw new HttpError(422, 'The text file contains too little readable content.');
    return { text, transcript: text, sourceType: 'text file', provider: 'Local file extraction' };
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const extracted = await mammoth.extractRawText({ buffer: await readFile(file.path) });
    const text = extracted.value.trim();
    if (text.length < 25) throw new HttpError(422, 'The DOCX contains too little readable text.');
    return { text, transcript: text, sourceType: 'DOCX document', provider: 'Mammoth · local document extraction' };
  }
  if (ext === '.xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await readFile(file.path));
    const text = workbook.worksheets.map(sheet => `SHEET: ${sheet.name}\n${sheet.getSheetValues().slice(1).map(row => Array.isArray(row) ? row.slice(1).map(value => String(value ?? '')).join('\t') : '').join('\n')}`).join('\n\n').trim();
    if (text.length < 2) throw new HttpError(422, 'The XLSX contains no readable cell values.');
    return { text, transcript: text, sourceType: `XLSX · ${workbook.worksheets.length} sheet(s)`, provider: 'ExcelJS · local spreadsheet extraction' };
  }
  if (ext === '.pdf' || file.mimeType === 'application/pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await readFile(file.path));
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
    const pages = [];
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str || '').join(' '));
    }
    const text = pages.join('\n').trim();
    if (text.length < 25) {
      if (execution.deviceCondition === 'Offline') throw new HttpError(503, 'REAL EXECUTION UNAVAILABLE: scanned PDF OCR is blocked in Offline mode; no local PDF OCR renderer is installed.');
      const ocr = await extractPdfWithGemini(file);
      if (ocr.text.length < 25) throw new HttpError(422, 'Gemini did not find readable text in this scanned PDF.');
      return { text: ocr.text, transcript: ocr.text, sourceType: `Scanned PDF · ${doc.numPages} page(s)`, provider: ocr.provider, model: ocr.model };
    }
    return { text, transcript: text, sourceType: `PDF · ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`, provider: 'PDF.js · local text extraction' };
  }
  if (file.mimeType.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|webm|mp4)$/i.test(file.originalName)) {
    const result = await transcribeAudio(file);
    return { text: result.text, transcript: result.text, sourceType: 'audio transcription', provider: result.provider, model: result.model };
  }
  throw new HttpError(415, 'Supported document input includes TXT, MD, CSV, JSON, DOCX, XLSX, and PDF; audio/video needs an online transcription provider.');
}

async function processReceipt(execution, file) {
  if (!file || (!file.mimeType.startsWith('image/') && file.mimeType !== 'application/pdf' && extname(file.originalName).toLowerCase() !== '.pdf')) throw new HttpError(422, 'Attach a receipt image or PDF.');
  let ocr, parsed, remote = null, providerWarning = null;
  try {
    if (execution.deviceCondition === 'Normal' && file.mimeType === 'application/pdf' && providerStatus().providerId === 'groq') {
      const source = await extractStudySource(execution, file, '');
      remote = await analyzeReceiptText(source.text);
      ocr = { text: source.text, confidence: null, model: remote.model, provider: remote.provider };
    } else if (execution.deviceCondition === 'Normal' && providerStatus().supportsVision) {
      remote = await analyzeReceiptImage(file);
      ocr = { text: 'Extracted by configured vision model', confidence: null, model: remote.model, provider: remote.provider };
    }
    if (remote) parsed = receiptFromProvider(remote.data, ocr.text);
  } catch (error) { providerWarning = `Configured vision model unavailable: ${error.message}. Fell back to local OCR.`; }
  if (!parsed) {
    if (!file.mimeType.startsWith('image/')) throw new HttpError(503, `REAL EXECUTION UNAVAILABLE: this PDF receipt could not be extracted. ${providerWarning || 'Local scanned-PDF OCR is not installed.'}`);
    ocr = await recognizeImage(await readFile(file.path));
    parsed = parseReceiptText(ocr.text, ocr.confidence);
  }
  if (!parsed.items.length) throw new HttpError(422, 'The receipt image was read, but no item/price pairs could be identified. Try a clearer or higher-resolution image; the recognized text is available in the execution details.');
  parsed.provider = ocr.provider;
  parsed.model = ocr.model;
  parsed.providerTrace = remote?.providerTrace || [];
  if (parsed.items.every(item => item.category && item.category !== 'Uncategorized')) { parsed.categoryProvider = ocr.provider; parsed.categoryModel = ocr.model; }
  parsed.rawText = ocr.text;
  parsed.warnings = [providerWarning, parsed.discrepancy != null && Math.abs(parsed.discrepancy) > 0.02 ? `Calculated total differs from printed total by ${parsed.currencySymbol}${Math.abs(parsed.discrepancy).toFixed(2)}.` : null, parsed.lineItemsDiscrepancy != null && Math.abs(parsed.lineItemsDiscrepancy) > 0.02 ? `Extracted line items differ from the printed subtotal by ${parsed.currencySymbol}${Math.abs(parsed.lineItemsDiscrepancy).toFixed(2)}.` : null, parsed.discrepancy == null ? 'Printed total was not found; verify the calculated line-item sum.' : null, parsed.ocrConfidence != null && parsed.ocrConfidence < 55 ? 'OCR confidence is low; review the extracted items.' : null].filter(Boolean);
  return parsed;
}

async function processPlant(execution, file) {
  if (!file || !file.mimeType.startsWith('image/')) throw new HttpError(422, 'Plant Analysis needs a plant photo upload.');
  let result, providerWarning = null;
  try {
    const remote = execution.deviceCondition === 'Normal' ? await analyzePlantImage(file) : null;
    if (remote) result = { ...remote.data, provider: remote.provider, model: remote.model, providerTrace: remote.providerTrace || [] };
  } catch (error) { providerWarning = `Configured vision model unavailable: ${error.message}. Used low-confidence local pixel analysis.`; }
  if (!result) result = await inspectPlantImage(await readFile(file.path));
  result.confidence = Number.isFinite(Number(result.confidence)) ? Math.max(0, Math.min(1, Number(result.confidence))) : .1;
  result.confidencePercent = Math.round(result.confidence * 100);
  result.warnings = [providerWarning, result.confidence < .55 ? 'Confidence is low. This is an uncertain model assessment, not a diagnosis.' : null].filter(Boolean);
  return result;
}

function validateStudyPack(data, sourceText = '') {
  if (!data || typeof data.summary !== 'string' || !Array.isArray(data.keyConcepts) || !Array.isArray(data.studyNotes) || !Array.isArray(data.quizQuestions)) throw new Error('The configured model did not return the expected study-pack fields.');
  if (data.keyConcepts.length !== 5 || data.quizQuestions.length !== 5) throw new Error('The configured model did not produce exactly five concepts and quiz questions.');
  if (data.quizQuestions.some(q => !q.question || !String(q.answer||'').trim())) throw new Error('The configured model returned an incomplete quiz or answer key.');
  const sourceWords = sourceText.trim().split(/\s+/).filter(Boolean).length;
  const summaryWords = data.summary.trim().split(/\s+/).filter(Boolean).length;
  if (sourceWords > 100 && (summaryWords > 80 || summaryWords > sourceWords * .2)) throw new Error('The generated summary was not concise enough relative to its source.');
  return { summary: data.summary, keyConcepts: data.keyConcepts, studyNotes: data.studyNotes, quizQuestions: data.quizQuestions, transcript: '', provider: null, model: null };
}

async function studyPackFromSource(source, condition = 'Normal', outputLanguage = 'AUTO') {
  let result;
  if (condition === 'Offline') {
    const { franc } = await import('franc-min');
    const detected = franc(source.text, { minLength: 20 });
    if (detected !== 'eng' || (outputLanguage !== 'AUTO' && outputLanguage !== 'English')) throw new HttpError(503, 'REAL EXECUTION UNAVAILABLE: the installed local study tools support English extractive output only; this task needs an online multilingual model.');
    result = createStudyPack(source.text, source.transcript);
    result.limitations = `${condition} profile selected the installed lightweight local text pipeline. ${result.limitations}`;
  } else try {
    const remote = await generateStudyPack(source.text, outputLanguage || 'AUTO');
    result = validateStudyPack(remote.data, source.text);
    result.transcript = source.transcript;
    result.provider = remote.provider;
    result.model = remote.model;
    result.providerTrace = remote.providerTrace;
  } catch (error) {
    if (!providerStatus().configured) {
      const { franc } = await import('franc-min');
      if (franc(source.text, { minLength: 20 }) !== 'eng' || (outputLanguage !== 'AUTO' && outputLanguage !== 'English')) throw new HttpError(503, 'REAL EXECUTION UNAVAILABLE: this language task requires an online multilingual model; the local fallback supports English only.');
      if (/not enough|too little|no transcript/.test(error.message)) throw error;
      result = createStudyPack(source.text, source.transcript);
    } else {
      throw new HttpError(503, `REAL EXECUTION UNAVAILABLE: study generation failed and no local generative language model is installed. ${String(error.message).replace(/^REAL EXECUTION UNAVAILABLE:\s*/i,'')}`);
    }
  }
  result.sourceType = source.sourceType;
  return result;
}

function updateHistory(execution) {
  const index = state.executions.findIndex(item => item.id === execution.id);
  if (index >= 0) state.executions[index] = execution;
  else state.executions.unshift(execution);
  state.executions = state.executions.slice(0, 250);
}
const activeRunners = new Map();
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function checkControl(execution) {
  while (execution.status === 'paused' && !execution.cancelRequested) await wait(200);
  if (execution.cancelRequested) throw new Error('Execution stopped by user.');
}
async function runExecution(execution, inputFiles, textInput) {
  const files = Array.isArray(inputFiles) ? inputFiles : inputFiles ? [inputFiles] : [];
  const file = files[0] || null;
  const context = { request: execution.request, inputs: { text: textInput, files: files.map(({ id, originalName, mimeType, size }) => ({ id, originalName, mimeType, size })) }, plan: execution.workflow, currentStep: null, stepResults: {}, artifacts: [], variables: {}, errors: [], providerTrace: (execution.providerTrace || []).map(event => ({ ...event, capability: event.capability || 'workflow planning' })), finalResult: null, file, files, textInput, source: null, result: {}, categorized: [] };
  execution.executionContext = { request: context.request, inputs: context.inputs, plan: context.plan, currentStep: null, stepResults: {}, artifacts: [], variables: {}, errors: [], providerTrace: [], finalResult: null };
  execution.executionContext.providerTrace = context.providerTrace;
  const delay = Math.max(60, 300 / Number(execution.speed || 1));
  try {
    execution.status = 'running';
    execution.startedAt = now();
    appendLog(execution, 'Workflow generated from current request; input processing started.');
    await saveState();
    for (let index = 0; index < execution.steps.length; index++) {
      await checkControl(execution);
      const step = execution.steps[index];
      patchStep(execution, index, { status: 'running', startedAt: now() });
      appendLog(execution, `Running: ${step.name}.`);
      await saveState();
      const action = step.action;
      context.currentStep = { index, id: step.id, action, name: step.name };
      execution.executionContext.currentStep = context.currentStep;
      const priorStep = index > 0 ? execution.steps[index - 1] : null;
      const priorOutput = priorStep ? context.stepResults[priorStep.id]?.output : { request: context.request, inputs: context.inputs };
      step.executionInput = structuredClone(priorOutput);
      if (action === 'capture') {
        if (!file) throw new HttpError(422, `${execution.workflow.title} requires an uploaded file.`);
        context.result.input = { name: file.originalName, type: file.mimeType, sizeBytes: file.size };
      } else if (action === 'extract_receipt') {
        if (file) context.result.receipt = await processReceipt(execution, file);
        else {
          const expenseText = `${execution.request || ''}\n${textInput || ''}`
            .replace(/^\s*(?:please\s+)?(?:categorize|categorise|classify)\s+(?:these\s+)?expenses?\s*:\s*/i, '')
            .replace(/,\s*(?=[A-Za-z])/g, '\n');
          const parsed = parseReceiptText(expenseText);
          if (!parsed.items.length) throw new HttpError(422, 'No expense item and amount pairs were found in the provided text.');
          parsed.provider = 'Local text extraction';
          parsed.model = 'Deterministic expense text parser';
          parsed.warnings = [];
          context.result.receipt = parsed;
        }
        execution.decisions = execution.decisions.map(d => d.stepId === step.id ? { ...d, model: context.result.receipt.model, provider: context.result.receipt.provider, mode: context.result.receipt.provider === 'Tesseract.js · local OCR' ? 'LOCAL' : 'CLOUD', reason: context.result.receipt.warnings.some(w => w.includes('Fell back')) ? context.result.receipt.warnings[0] : `Actual receipt image processed by ${context.result.receipt.provider}.` } : d);
      } else if (action === 'calculate_total') {
        const receipt = context.result.receipt;
        receipt.lineItemsTotal = Number(receipt.items.reduce((sum, item) => sum + Number(item.amount), 0).toFixed(2));
        receipt.calculatedTotal = Number((receipt.lineItemsTotal + (receipt.tax || 0)).toFixed(2));
        receipt.discrepancy = receipt.receiptTotal == null ? null : Number((receipt.calculatedTotal - receipt.receiptTotal).toFixed(2));
        receipt.lineItemsDiscrepancy = receipt.subtotal == null ? null : Number((receipt.lineItemsTotal - receipt.subtotal).toFixed(2));
        receipt.discrepancyFlag = receipt.discrepancy != null && Math.abs(receipt.discrepancy) > .02 ? 'calculated total differs from printed total' : receipt.lineItemsDiscrepancy != null && Math.abs(receipt.lineItemsDiscrepancy) > .02 ? 'extracted line items differ from printed subtotal' : receipt.discrepancy == null ? 'receipt total not found' : 'totals match';
      } else if (action === 'categorize') {
        const receipt = context.result.receipt;
        if (receipt.items.some(item => !item.category || item.category === 'Uncategorized')) {
          if (execution.deviceCondition === 'Offline' || !providerStatus().configured) throw new HttpError(503, 'REAL EXECUTION UNAVAILABLE: semantic receipt categorization requires a configured online AI provider; extracted items and deterministic totals are preserved, but categories are unavailable.');
          const categorized = await categorizeReceiptItems(receipt.items);
          receipt.items = categorized.items; receipt.categoryModel = categorized.model; receipt.categoryProvider = categorized.provider;
          receipt.categorizationTrace = categorized.providerTrace || [];
        }
        receipt.categoryTotals = Object.entries(receipt.items.reduce((result, item) => { result[item.category] = (result[item.category] || 0) + item.amount; return result; }, {})).map(([category, total]) => ({ category, total: Number(total.toFixed(2)) }));
      } else if (action === 'confirm_expense') {
        execution.result = context.result;
        if (!context.result.receipt?.items?.length || context.result.receipt.items.some(item => !item.category || item.category === 'Uncategorized') || !context.result.receipt.categoryTotals?.length) {
          throw new HttpError(409, 'Expense tracker action blocked: all receipt items must have successful semantic categories before an expense can be confirmed.');
        }
        execution.modelsUsed = [
          ...(execution.modelsUsed || []).filter(event => event.capability === 'workflow planning'),
          ...(context.result.receipt.model? [{ capability:'receipt extraction', model:context.result.receipt.model, provider:context.result.receipt.provider, executionMode:context.result.receipt.provider==='Tesseract.js · local OCR'?'LOCAL':'REAL', status:'USED', completedAt:now() }]:[]),
          ...(context.result.receipt.categoryModel? [{ capability:'receipt item categorization', model:context.result.receipt.categoryModel, provider:context.result.receipt.categoryProvider, executionMode:'REAL', status:'USED', completedAt:now() }]:[]),
          { capability:'receipt arithmetic', model:null, provider:'Local deterministic calculation', executionMode:'LOCAL', status:'USED', completedAt:now() }
        ];
        execution.modelsUsedVerified = true;
        execution.status = 'awaiting-confirmation';
        execution.confirmation = { title: 'CONFIRM ACTION', amount: context.result.receipt.calculatedTotal, currency: context.result.receipt.currency, currencySymbol: context.result.receipt.currencySymbol, merchant: context.result.receipt.merchant, categories: context.result.receipt.categoryTotals, targetAccount: execution.targetAccount || 'Personal Expenses', action: 'Add this receipt to the local OrchAI expense tracker' };
        patchStep(execution, index, { status: 'awaiting-confirmation', finishedAt: now() });
        appendLog(execution, 'Waiting for explicit confirmation. No expense record has been written.', 'warning');
        break;
      } else if (action === 'read_source') {
        const audioInput = file && (file.mimeType.startsWith('audio/') || /\.(?:wav|mp3|m4a|ogg|webm|mp4)$/i.test(file.originalName));
        context.source = audioInput ? { file, text: '', transcript: '', sourceType: `audio file · ${file.originalName}`, provider: 'User upload' } : await extractStudySource(execution, file, textInput);
        context.result.source = { filename: file?.originalName || 'Pasted lecture text', sourceType: context.source.sourceType, textCharacters: context.source.text.length };
      } else if (action === 'transcribe') {
        if (context.source.file) {
          if (execution.deviceCondition === 'Offline') throw new HttpError(503, 'Offline mode is active and no local speech-to-text model is installed. Switch online or provide a transcript/text document.');
          const transcription = await transcribeAudio(context.source.file);
          context.source.text = transcription.text; context.source.transcript = transcription.text;
          context.source.provider = transcription.provider; context.source.model = transcription.model;
          context.result.transcriptionTrace = transcription.providerTrace || [];
          context.result.source.textCharacters = transcription.text.length;
        }
        context.result.transcript = context.source.transcript;
        context.result.transcriptionProvider = context.source.provider;
        context.result.transcriptionModel = context.source.model || null;
      } else if (['concepts', 'notes', 'quiz'].includes(action)) {
        context.result.studyPack ||= await studyPackFromSource(context.source, execution.deviceCondition, execution.outputLanguage || 'AUTO');
        if (action === 'concepts') context.result.studyPack.keyConcepts = context.result.studyPack.keyConcepts.slice(0, 5);
        if (action === 'quiz') context.result.studyPack.quizQuestions = context.result.studyPack.quizQuestions.slice(0, 5);
      } else if (action === 'plant_quality') {
        if (!file || !file.mimeType.startsWith('image/')) throw new HttpError(422, 'Plant Analysis needs a plant photo upload.');
        const sharp = (await import('sharp')).default;
        const metadata = await sharp(await readFile(file.path)).metadata();
        if (!metadata.width || !metadata.height) throw new HttpError(422, 'The uploaded plant photo could not be decoded.');
        context.result.image = { name: file.originalName, type: file.mimeType, sizeBytes: file.size, width: metadata.width, height: metadata.height, qualityCheck: 'decoded image with dimensions verified' };
      } else if (action === 'plant_assessment') {
        context.result.plant = await processPlant(execution, file);
        execution.decisions = execution.decisions.map(d => d.stepId === step.id ? { ...d, model: context.result.plant.model, provider: context.result.plant.provider, mode: context.result.plant.provider === 'Local image feature analysis' ? 'LOCAL' : 'CLOUD', reason: context.result.plant.limitations || context.result.plant.observation } : d);
      } else if (action === 'plant_symptoms') {
        if (!context.result.plant) throw new Error('Plant symptom step requires the previous image-assessment result.');
        context.result.plant.symptomSummary = context.result.plant.symptoms || context.result.plant.observation || null;
      } else if (action === 'plant_treatment') {
        if (!context.result.plant) throw new Error('Plant treatment step requires the previous assessment result.');
        context.result.plant.treatmentSummary = context.result.plant.treatmentInformation || null;
      } else if (action === 'care_plan') {
        if (!context.result.plant) throw new Error('Care-plan step requires the previous plant assessment result.');
        context.result.plant.carePlan = Array.isArray(context.result.plant.carePlan) ? context.result.plant.carePlan : Array.isArray(context.result.plant.recommendedNextSteps) ? context.result.plant.recommendedNextSteps : [];
        context.result.plant.cautions = [...(context.result.plant.warnings || []), context.result.plant.limitations].filter(Boolean);
      }
      else if (action === 'validate_pdf_inputs') {
        if (files.length < 2) throw new HttpError(422, 'Attach at least two PDF files to merge.');
        const invalid = files.find(item => item.mimeType !== 'application/pdf' && extname(item.originalName).toLowerCase() !== '.pdf');
        if (invalid) throw new HttpError(415, `${invalid.originalName} is not a PDF file. No output was created.`);
        context.result.pdfMerge = { inputCount: files.length };
      } else if (action === 'merge_pdfs') {
        const merged = await PDFDocument.create();
        for (const input of files) {
          const document = await PDFDocument.load(await readFile(input.path));
          const pages = await merged.copyPages(document, document.getPageIndices());
          pages.forEach(page => merged.addPage(page));
        }
        const artifactId = uuid();
        await writeFile(join(UPLOADS, `orchai-merged-${artifactId}.pdf`), await merged.save(), { flag: 'wx' });
        context.result.pdfMerge = { inputCount: files.length, pageCount: merged.getPageCount(), filename: 'orchai-merged.pdf', downloadUrl: `/api/executions/${execution.id}/artifact`, artifactId };
      }
      else if (action === 'general_task') {
        if (execution.deviceCondition === 'Offline') throw new HttpError(503, 'DEVICE CONSTRAINT: Offline mode is active. No compatible local language model is installed. REAL EXECUTION UNAVAILABLE.');
        
        let inputText = textInput;
        const visionFiles = [];
        for (const input of files) {
          if (input.mimeType.startsWith('image/')) { visionFiles.push(input); continue; }
          if (input.mimeType.startsWith('audio/') || input.mimeType.startsWith('video/')) throw new HttpError(415, `REAL EXECUTION UNAVAILABLE: this task needs the speech-to-text or video-understanding capability for ${input.originalName}.`);
          const extracted = await extractStudySource(execution, input, '');
          inputText += `\n\nFILE: ${input.originalName}\n${extracted.text}`;
          if (extracted.model && extracted.provider) context.inputModels = [...(context.inputModels || []), { capability: extracted.sourceType === 'audio transcription' ? 'speech-to-text' : 'document extraction', model: extracted.model, provider: extracted.provider }];
        }
        const languageInstruction = execution.outputLanguage && execution.outputLanguage !== 'AUTO' ? `\n\nWrite the response in ${execution.outputLanguage}.` : '';
        const taskPrompt = `${execution.request}${languageInstruction}${inputText ? `\n\nUser-provided and locally extracted task input:\n${inputText.slice(0, 90000)}` : ''}`;
        const primary = providerStatus();
        const primaryModel = ['Low RAM', 'Low Battery'].includes(execution.deviceCondition) && primary.providerId === 'gemini' ? 'gemini-3.5-flash-lite' : primary.model;
        const answer = visionFiles.length ? await generateTextWithFiles(taskPrompt, visionFiles, primaryModel && primaryModel !== primary.model ? { model: primaryModel } : {}) : await generateText(taskPrompt, primaryModel && primaryModel !== primary.model ? { model: primaryModel } : {});
        context.result.answer = answer.text;
        context.result.providerTrace = answer.providerTrace || [];
        context.result.inputFiles = files.map(item => ({ name: item.originalName, type: item.mimeType, size: item.size }));
        const plannerEvents = (execution.modelsUsed || []).filter(event => event.capability === 'workflow planning');
        const inputEvents = (context.inputModels || []).map(model => ({ ...model, executionMode: /^(Local|PDF\.js)/.test(model.provider) ? 'LOCAL' : 'REAL', status: 'USED', completedAt: now() }));
        execution.modelsUsed = [...plannerEvents, ...inputEvents, { capability: 'natural-language reasoning', model: answer.model, provider: answer.provider, executionMode: 'REAL', status: 'USED', completedAt: now() }];
        execution.decisions = execution.decisions.map(decision => decision.stepId === step.id ? { ...decision, model: answer.model, provider: answer.provider, mode: 'CLOUD', selected: true, status: 'used', reason: execution.fallback?.reason || `Configured ${answer.provider} provider completed one generation call under the ${execution.deviceCondition} profile.` } : decision);
      }
      const trace = action === 'extract_receipt' ? context.result.receipt?.providerTrace : action === 'categorize' ? context.result.receipt?.categorizationTrace : action === 'plant_assessment' ? context.result.plant?.providerTrace : ['concepts', 'notes', 'quiz'].includes(action) ? context.result.studyPack?.providerTrace : action === 'transcribe' ? context.result.transcriptionTrace : action === 'general_task' ? context.result.providerTrace : null;
      if (Array.isArray(trace) && trace.length) {
        const tagged = trace.map(event => ({ ...event, capability: step.capability }));
        context.providerTrace.push(...tagged);
        execution.executionContext.providerTrace = context.providerTrace;
        execution.providerTrace = context.providerTrace;
        const fallbackUsed = tagged.some(event => event.fallbackUsed);
        if (fallbackUsed) {
          const primaryAttempt = tagged.find(event => event.fallbackUsed && event.error);
          execution.fallback = { primary: { provider: primaryAttempt?.provider || 'Groq', model: primaryAttempt?.model || null, status: 'FAILED' }, candidates: tagged.filter(event => event.attempt > 1).map(event => ({ provider: event.provider, model: event.model, status: 'USED', compatible: true, duration: event.duration, attempt: event.attempt })), selected: { provider: tagged.at(-1).provider, model: tagged.at(-1).model }, reason: primaryAttempt?.error || 'Primary provider could not complete this operation.' };
          appendLog(execution, `Gemini fallback activated after Groq failed for ${step.capability}.`, 'warning');
          execution.decisions = execution.decisions.map(decision => decision.stepId === step.id ? { ...decision, model: tagged.at(-1).model, provider: tagged.at(-1).provider, reason: execution.fallback.reason } : decision);
        }
      }
      const structuredOutput = action === 'calculate_total' || action === 'categorize' || action === 'extract_receipt' ? structuredClone(context.result.receipt || {})
        : action === 'read_source' || action === 'transcribe' ? structuredClone(context.source || {})
          : ['concepts', 'notes', 'quiz'].includes(action) ? structuredClone(context.result.studyPack || {})
            : ['plant_quality', 'plant_assessment', 'plant_symptoms', 'plant_treatment', 'care_plan'].includes(action) ? structuredClone(context.result.plant || context.result.image || {})
              : action === 'general_task' ? { answer: context.result.answer, inputFiles: context.result.inputFiles || [] }
                : action === 'merge_pdfs' ? structuredClone(context.result.pdfMerge || {}) : structuredClone(context.result.input || {});
      context.stepResults[step.id] = { input: structuredClone(priorOutput), output: structuredOutput, completedAt: now() };
      context.variables[step.id] = structuredOutput;
      if (action === 'merge_pdfs' && context.result.pdfMerge?.artifactId) context.artifacts.push({ type: 'application/pdf', ...context.result.pdfMerge });
      execution.executionContext = { request: context.request, inputs: context.inputs, plan: context.plan, currentStep: context.currentStep, stepResults: context.stepResults, artifacts: context.artifacts, variables: context.variables, errors: context.errors, providerTrace: context.providerTrace, finalResult: context.result };
      step.executionInputFrom = priorStep?.id || 'request';
      step.executionInput = structuredClone(priorOutput);
      step.executionOutput = structuredOutput;
      await wait(delay);
      if (execution.status === 'stopped' || execution.cancelRequested) throw new Error('Execution stopped by user.');
      patchStep(execution, index, { status: 'completed', finishedAt: now(), output: outputForAction(action, context) });
      appendLog(execution, `Completed: ${step.name}.`);
      await saveState();
    }
    if (execution.status !== 'awaiting-confirmation') {
      const incompleteSteps = execution.steps.filter(step => step.status !== 'completed');
      if (incompleteSteps.length) throw new Error(`Verification failed: workflow steps did not complete (${incompleteSteps.map(step => step.name).join(', ')}).`);
      if (execution.workflow.intent === 'expense' && (!context.result.receipt?.items?.length || context.result.receipt.items.some(item => !item.category || item.category === 'Uncategorized') || !context.result.receipt.categoryTotals?.length)) throw new Error('Verification failed: expense items and semantic categories are incomplete.');
      if (execution.workflow.intent === 'plant' && !context.result.plant) throw new Error('Verification failed: plant analysis output is missing.');
      if (execution.workflow.intent === 'study' && (!context.result.studyPack || context.result.studyPack.quizQuestions?.length !== 5)) throw new Error('Verification failed: the complete five-question study pack is missing.');
      if (execution.workflow.intent === 'general' && typeof context.result.answer !== 'string') throw new Error('Verification failed: final answer is missing.');
      execution.result = context.result;
      context.finalResult = context.result;
      execution.executionContext.finalResult = context.result;
      execution.status = 'completed';
      execution.completedAt = now();
      const actualModels = [];
      const addActual = (capability, model, provider) => { if (model && provider) actualModels.push({ capability, model, provider, executionMode: /^(Local|Tesseract|PDF\.js)/i.test(provider) ? 'LOCAL' : 'REAL', status: 'USED', completedAt: execution.completedAt }); };
      addActual('vision / receipt extraction', context.result.receipt?.model, context.result.receipt?.provider);
      addActual('plant image analysis', context.result.plant?.model, context.result.plant?.provider);
      addActual('speech-to-text', context.source?.model, context.source?.provider);
      if (context.source?.provider && /PDF\.js|Mammoth|ExcelJS|Local file extraction/.test(context.source.provider)) actualModels.push({ capability:'document extraction', model:null, provider:context.source.provider, executionMode:'LOCAL', status:'USED', completedAt:execution.completedAt });
      addActual('text generation', context.result.studyPack?.model, context.result.studyPack?.provider);
      if (context.result.studyPack && !context.result.studyPack.model && !context.result.studyPack.provider) actualModels.push({ capability: 'study-pack generation', model: 'Local extractive study-pack pipeline', provider: 'Local', executionMode: 'LOCAL', status: 'USED', completedAt: execution.completedAt });
      if (context.result.pdfMerge) actualModels.push({ capability: 'PDF merge', model: null, provider: 'Local PDF processor', executionMode: 'LOCAL', status: 'USED', completedAt: execution.completedAt });
      if (context.result.receipt?.categoryModel) actualModels.push({ capability: 'receipt item categorization', model: context.result.receipt.categoryModel, provider: context.result.receipt.categoryProvider, executionMode: 'REAL', status: 'USED', completedAt: execution.completedAt });
      if (context.result.receipt) actualModels.push({ capability: 'receipt arithmetic', model: null, provider: 'Local deterministic calculation', executionMode: 'LOCAL', status: 'USED', completedAt: execution.completedAt });
      if (context.result.answer && files.some(input=>['.docx','.xlsx','.pdf'].includes(extname(input.originalName).toLowerCase()))) actualModels.push({ capability: 'document extraction', model: null, provider: 'Local document processor', executionMode: 'LOCAL', status: 'USED', completedAt: execution.completedAt });
      if (context.result.studyPack?.warnings?.length) appendLog(execution, context.result.studyPack.warnings[0], 'warning');
      if (actualModels.length) execution.modelsUsed = [...(execution.modelsUsed || []).filter(event => event.capability === 'workflow planning'), ...actualModels];
      execution.modelsUsedVerified = true;
      appendLog(execution, 'Result persisted to local OrchAI history.');
    }
  } catch (error) {
    if (Object.keys(context.result||{}).length) execution.result = context.result;
    execution.status = execution.cancelRequested || execution.status === 'stopped' ? 'stopped' : 'failed';
    execution.error = error.message;
    execution.completedAt = now();
    if (!Array.isArray(execution.modelsUsed)) execution.modelsUsed = [];
    const failedStep=execution.steps[execution.currentStepIndex];
    if (execution.modelsUsed.length===0 && !['categorize','concepts','notes','quiz'].includes(failedStep?.action)) execution.modelsUsed.push({ capability:failedStep?.capability||'task execution', model:null, provider:'OrchAI execution engine', executionMode:'—', status:'UNAVAILABLE', error:error.message, completedAt:now() });
    if (context.result.receipt && !execution.modelsUsed.some(event=>event.capability==='receipt extraction')) execution.modelsUsed.push({ capability: 'receipt extraction', model: context.result.receipt.model || null, provider: context.result.receipt.provider || 'Local receipt parser', executionMode: context.result.receipt.provider==='Tesseract.js · local OCR'?'LOCAL':'REAL', status: 'USED', completedAt: now() });
    if (context.result.receipt && execution.steps.some(step=>step.action==='calculate_total'&&step.status==='completed') && !execution.modelsUsed.some(event=>event.capability==='receipt arithmetic')) execution.modelsUsed.push({ capability:'receipt arithmetic', model:null, provider:'Local deterministic calculation', executionMode:'LOCAL', status:'USED', completedAt:now() });
    if (execution.steps[execution.currentStepIndex]?.action === 'categorize' && !context.result.receipt?.categoryModel) execution.modelsUsed.push({ capability: 'receipt item categorization', model: providerStatus().configured?providerStatus().model:null, provider: providerStatus().configured?providerStatus().provider:'Unavailable', executionMode: providerStatus().configured?'REAL':'—', status: providerStatus().configured?'FAILED':'UNAVAILABLE', error: error.message, completedAt: now() });
    if (['concepts','notes','quiz'].includes(execution.steps[execution.currentStepIndex]?.action) && !context.result.studyPack) execution.modelsUsed.push({ capability:'study-pack generation', model:providerStatus().configured?providerStatus().model:null, provider:providerStatus().configured?providerStatus().provider:'Unavailable', executionMode:providerStatus().configured?'REAL':'—', status:providerStatus().configured?'FAILED':'UNAVAILABLE', error:error.message, completedAt:now() });
    execution.modelsUsedVerified = true;
    appendLog(execution, error.message, 'error');
    const active = execution.steps.findIndex(step => step.status === 'running');
    if (active >= 0) patchStep(execution, active, { status: 'failed', error: error.message, finishedAt: now() });
    const failedIndex = active >= 0 ? active : execution.currentStepIndex;
    for (let index = failedIndex + 1; index < execution.steps.length; index++) {
      if (execution.steps[index].status === 'queued') execution.steps[index] = { ...execution.steps[index], status: 'blocked', error: `Blocked because prerequisite step “${execution.steps[failedIndex]?.name || 'an earlier step'}” did not complete.`, updatedAt: now() };
    }
    if (execution.steps.some(step => step.action === 'categorize' && step.status === 'failed')) {
      const expenseAction = execution.steps.find(step => step.action === 'confirm_expense');
      if (expenseAction && expenseAction.status !== 'completed') {
        expenseAction.status = 'blocked';
        expenseAction.error = 'Blocked because expense items were not successfully categorized.';
        expenseAction.updatedAt = now();
      }
    }
  } finally {
    execution.updatedAt = now();
    updateHistory(execution);
    await saveState();
    activeRunners.delete(execution.id);
  }
}
function resumePersistedRuns() {
  for (const execution of state.executions) {
    if (!['queued', 'running', 'paused'].includes(execution.status)) continue;
    const savedInputs = execution.inputFiles || (execution.file ? [execution.file] : []);
    const files = [];
    let missingInput = false;
    for (const saved of savedInputs) {
      const filePath = join(UPLOADS, `${saved.id}${extname(saved.originalName)}`);
      if (!existsSync(filePath)) { missingInput = true; break; }
      files.push({ ...saved, path: filePath });
    }
    if (missingInput) { execution.status = 'failed'; execution.error = 'A saved input is missing; this interrupted run cannot be resumed.'; appendLog(execution, execution.error, 'error'); updateHistory(execution); continue; }
    execution.steps = execution.steps.map(step => ({ ...step, status: 'queued', error: undefined, startedAt: undefined, finishedAt: undefined }));
    execution.status = 'queued'; execution.currentStepIndex = -1; execution.result = null; execution.error = null;
    appendLog(execution, 'The server restarted during this run; execution resumed from the saved input.');
    const promise = runExecution(execution, files, execution.textInput || '');
    activeRunners.set(execution.id, promise);
  }
  void saveState();
}
function outputForAction(action, context) {
  if (action === 'general_task') return context.result.answer || 'Task completed.';
  if (action === 'validate_pdf_inputs') return `${context.files.length} PDF inputs validated`;
  if (action === 'merge_pdfs') return `${context.result.pdfMerge.pageCount} pages merged into one PDF`;
  if (action === 'extract_receipt') return `${context.result.receipt?.items.length || 0} receipt line items extracted`;
  if (action === 'calculate_total') return `${context.result.receipt?.currencySymbol || ''}${context.result.receipt?.calculatedTotal?.toFixed(2) ?? '—'} · ${context.result.receipt?.discrepancyFlag}`;
  if (action === 'categorize') return `${context.result.receipt?.categoryTotals?.length || 0} categories derived from uploaded line items`;
  if (action === 'read_source') return `${context.source?.text.length || 0} source characters extracted`;
  if (action === 'transcribe') return `${context.source?.transcript.length || 0} transcript characters`;
  if (action === 'concepts') return 'Five concepts grounded in the source text';
  if (action === 'notes') return 'Notes generated from actual source content';
  if (action === 'quiz') return 'Five questions grounded in source content';
  if (action === 'plant_assessment') return `${context.result.plant?.confidencePercent ?? 0}% confidence · uncertain assessment shown`;
  if (action === 'confirm_expense') return 'Awaiting user confirmation';
  return 'Input received';
}

function safeUploadName(name) { return basename(name || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'upload'; }
function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new HttpError(400, 'Multipart upload boundary is missing.');
  const boundary = Buffer.from(`--${(boundaryMatch[1] || boundaryMatch[2]).trim()}`);
  const fields = {}, files = {};
  let start = 0;
  while (true) {
    const boundaryStart = buffer.indexOf(boundary, start);
    if (boundaryStart < 0) break;
    let partStart = boundaryStart + boundary.length;
    if (buffer.subarray(partStart, partStart + 2).toString() === '--') break;
    if (buffer.subarray(partStart, partStart + 2).toString() === '\r\n') partStart += 2;
    const nextBoundary = buffer.indexOf(boundary, partStart);
    if (nextBoundary < 0) break;
    let partEnd = nextBoundary;
    if (buffer.subarray(partEnd - 2, partEnd).toString() === '\r\n') partEnd -= 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), partStart);
    if (headerEnd < 0 || headerEnd > partEnd) { start = nextBoundary; continue; }
    const headers = buffer.subarray(partStart, headerEnd).toString('utf8');
    const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const name = disposition.match(/name="([^"]+)"/i)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
    const content = buffer.subarray(headerEnd + 4, partEnd);
    if (name && filename) (files[name] ||= []).push({ originalName: safeUploadName(filename), mimeType: headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() || 'application/octet-stream', content });
    else if (name) fields[name] = content.toString('utf8');
    start = nextBoundary;
  }
  return { fields, files };
}
async function readRequest(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES + 1024 * 1024) throw new HttpError(413, 'Upload exceeds the 30 MB limit.');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if ((request.headers['content-type'] || '').includes('multipart/form-data')) return { ...parseMultipart(body, request.headers['content-type']), body };
  if ((request.headers['content-type'] || '').includes('application/json')) {
    try { return { json: JSON.parse(body.toString('utf8')), fields: {}, files: {}, body }; }
    catch { throw new HttpError(400, 'Request body is not valid JSON.'); }
  }
  return { fields: {}, files: {}, body };
}
async function saveUpload(upload) {
  if (!upload) return null;
  if (upload.content.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Upload exceeds the 30 MB limit.');
  const id = uuid();
  const ext = extname(upload.originalName).slice(0, 12) || '.bin';
  const filePath = join(UPLOADS, `${id}${ext}`);
  await writeFile(filePath, upload.content, { flag: 'wx' });
  return { id, originalName: upload.originalName, mimeType: upload.mimeType, size: upload.content.length, path: filePath };
}
async function saveUploads(uploads) { return Promise.all((uploads || []).map(saveUpload)); }

function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'http://127.0.0.1:5173', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  response.end(JSON.stringify(data));
}
async function serveStatic(response, pathname) {
  const file = resolve(ROOT, 'dist', `.${pathname === '/' ? '/index.html' : pathname}`);
  const dist = resolve(ROOT, 'dist');
  const fromDist = relative(dist, file);
  if (fromDist.startsWith('..') || isAbsolute(fromDist)) return false;
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
    response.end(await readFile(file));
    return true;
  } catch { return false; }
}

export async function handle(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Origin': 'http://127.0.0.1:5173', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return response.end(); }
  try {
    if (url.pathname === '/api/health' && request.method === 'GET') return send(response, 200, { ok: true, service: 'OrchAI local execution server', provider: providerStatus() });
    if (url.pathname === '/api/diagnostics/provider-key' && request.method === 'GET') return send(response, 200, providerKeyDiagnostic());
    if (url.pathname === '/api/diagnostics/gemini-key' && request.method === 'GET') return send(response, 200, providerKeyDiagnostic());
    if (url.pathname === '/api/diagnostics/provider-test' && request.method === 'POST') {
      const result = await testProviderConnection();
      return send(response, 200, { ok: true, provider: result.provider, model: result.model, response: result.text });
    }
    if (url.pathname === '/api/state' && request.method === 'GET') return send(response, 200, { workflows: state.workflows.map(asFlow), history: state.executions, expenses: state.expenses, provider: providerStatus() });
    const inputArtifactMatch = url.pathname.match(/^\/api\/executions\/([\w-]+)\/input\/([\w-]+)$/);
    if (inputArtifactMatch && request.method === 'GET') {
      const execution = state.executions.find(item => item.id === inputArtifactMatch[1]);
      const input = (execution?.inputFiles || (execution?.file ? [execution.file] : [])).find(item => item.id === inputArtifactMatch[2]);
      if (!input) throw new HttpError(404, 'Original input file is no longer available.');
      const filePath = join(UPLOADS, `${input.id}${extname(input.originalName)}`);
      try { response.writeHead(200, { 'Content-Type': input.mimeType || 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(await readFile(filePath)); return; }
      catch { throw new HttpError(404, 'Original input file is no longer available.'); }
    }
    if (url.pathname === '/api/workflows/plan' && request.method === 'POST') {
      const body = await readRequest(request);
      const payload = body.json || body.fields;
      const condition = payload.condition || 'Normal';
      const plan = await planWorkflow(payload.prompt || '', { mimeType: payload.mimeType || '', filename: payload.filename || '', condition });
      plan.decisions = routeDecisions(plan, condition);
      state.workflows.unshift(plan);
      state.workflows = state.workflows.slice(0, 100);
      await saveState();
      return send(response, 201, { workflow: asFlow(plan), decisions: plan.decisions, provider: providerStatus() });
    }
    if (url.pathname === '/api/workflows/route' && request.method === 'POST') {
      const body = await readRequest(request);
      const payload = body.json || {};
      const plan = state.workflows.find(workflow => workflow.id === payload.workflowId);
      if (!plan) throw new HttpError(404, 'Generated workflow plan was not found. Generate the plan again.');
      const decisions = routeDecisions(plan, payload.condition || 'Normal');
      return send(response, 200, { decisions, provider: providerStatus() });
    }
    if (url.pathname === '/api/executions' && request.method === 'POST') {
      const body = await readRequest(request);
      const payload = body.json || body.fields;
      const originalFiles = body.files?.file || [];
      const uploads = await saveUploads(originalFiles);
      const uploaded = uploads[0] || null;
      const content = payload.content || payload.prompt || '';
      let plan = payload.workflowId ? state.workflows.find(workflow => workflow.id === payload.workflowId) : null;
      if (!plan) plan = payload.workflow ? { planningEvent: null } : await planWorkflow(payload.prompt || '', { mimeType: uploaded?.mimeType || '', filename: uploaded?.originalName || '', condition: payload.condition || 'Normal' });
      if (payload.workflow) {
        let proposed;
        try { proposed = typeof payload.workflow === 'string' ? JSON.parse(payload.workflow) : payload.workflow; }
        catch { throw new HttpError(400, 'The edited workflow is not valid JSON. Generate the plan again.'); }
        if (!Array.isArray(proposed.steps) || proposed.steps.length < 1 || proposed.steps.length > 30 || proposed.steps.some(step => !step.id || !step.action || !step.name)) throw new HttpError(422, 'The edited workflow contains invalid or unsupported steps.');
        const intent = proposed.intent || inferIntent(payload.prompt, uploaded?.mimeType, uploaded?.originalName);
        const allowed = { expense: ['capture', 'extract_receipt', 'calculate_total', 'categorize', 'confirm_expense'], study: ['read_source', 'transcribe', 'concepts', 'notes', 'quiz'], plant: ['capture', 'plant_quality', 'plant_assessment', 'plant_symptoms', 'plant_treatment', 'care_plan'], general: ['general_task'] }[intent] || [];
        const required = { expense: ['extract_receipt', 'calculate_total', 'categorize'], study: ['read_source', 'concepts', 'notes', 'quiz'], plant: ['plant_quality', 'plant_assessment', 'plant_treatment', 'care_plan'], general: ['general_task'] }[intent] || [];
        if (!allowed.length || proposed.steps.some(step => !allowed.includes(step.action)) || required.some(action => !proposed.steps.some(step => step.action === action))) throw new HttpError(422, 'The edited workflow contains an unsupported step or is missing a required processing step. Restore the required steps and retry.');
        plan = { ...proposed, intent, steps: proposed.steps, planningEvent: plan.planningEvent || proposed.planningEvent || null };
      }
      const execution = { id: uuid(), workflowId: plan.id, workflow: asFlow(plan), outputLanguage: payload.outputLanguage || 'AUTO', request: payload.prompt || plan.request, textInput: payload.content || '', targetAccount: payload.targetAccount || 'Personal Expenses', deviceCondition: payload.condition || 'Normal', speed: Number(payload.speed || 1), status: 'queued', currentStepIndex: -1, createdAt: now(), updatedAt: now(), file: uploaded ? { id: uploaded.id, originalName: uploaded.originalName, mimeType: uploaded.mimeType, size: uploaded.size } : null, inputFiles: uploads.map(item => ({ id: item.id, originalName: item.originalName, mimeType: item.mimeType, size: item.size })), providerTrace: plan.planningEvent?.providerTrace || [], modelsUsed: plan.planningEvent ? [plan.planningEvent] : [], modelsUsedVerified: false, steps: plan.steps.map(step => ({ ...step, status: 'queued' })), decisions: routeDecisions(plan, payload.condition || 'Normal'), logs: [], result: null };
      updateHistory(execution);
      await saveState();
      const promise = runExecution(execution, uploads, payload.content || '');
      activeRunners.set(execution.id, promise);
      return send(response, 202, { execution });
    }
    const actionMatch = url.pathname.match(/^\/api\/executions\/([\w-]+)(?:\/(pause|resume|stop|confirm|cancel|artifact))?$/);
    if (actionMatch) {
      const execution = state.executions.find(item => item.id === actionMatch[1]);
      if (!execution) throw new HttpError(404, 'Execution was not found.');
      const action = actionMatch[2];
      if (request.method === 'GET' && action === 'artifact') {
        const artifact = execution.result?.pdfMerge;
        if (!artifact?.artifactId) throw new HttpError(404, 'This execution has no generated file.');
        const bytes = await readFile(join(UPLOADS, `orchai-merged-${artifact.artifactId}.pdf`));
        response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="orchai-merged.pdf"', 'Cache-Control': 'no-store' });
        response.end(bytes); return;
      }
      if (request.method === 'POST' && action === 'pause') {
        if (execution.status === 'running') execution.status = 'paused';
        appendLog(execution, 'Execution paused.'); await saveState(); return send(response, 200, { execution });
      }
      if (request.method === 'POST' && action === 'resume') {
        if (execution.status === 'paused') execution.status = 'running';
        appendLog(execution, 'Execution resumed.'); await saveState(); return send(response, 200, { execution });
      }
      if (request.method === 'POST' && action === 'stop') {
        execution.cancelRequested = true; execution.status = 'stopped'; appendLog(execution, 'Execution stopped by user.', 'warning'); await saveState(); return send(response, 200, { execution });
      }
      if (request.method === 'POST' && action === 'cancel') {
        if (execution.status !== 'awaiting-confirmation') throw new HttpError(409, 'This workflow is not waiting for action confirmation.');
        execution.status = 'stopped'; execution.confirmation = null; appendLog(execution, 'Action cancelled. No expense was added.', 'warning'); updateHistory(execution); await saveState(); return send(response, 200, { execution });
      }
      if (request.method === 'POST' && action === 'confirm') {
        if (execution.status !== 'awaiting-confirmation' || execution.workflow.intent !== 'expense') throw new HttpError(409, 'No expense action is currently awaiting confirmation.');
        const receipt = execution.result?.receipt;
        const categorization = execution.steps.find(step => step.action === 'categorize');
        if (categorization?.status !== 'completed' || !receipt?.items?.length || receipt.items.some(item => !item.category || item.category === 'Uncategorized') || !receipt.categoryTotals?.length) {
          throw new HttpError(409, 'Expense tracker action blocked: successful semantic categories are required before an expense can be written.');
        }
        const body = await readRequest(request);
        const payload = body.json || {};
        const confirmation = execution.confirmation;
        const allowedAccounts = ['Personal Expenses', 'Household', 'Business Expenses'];
        if (payload.confirmationAmount !== confirmation.amount || !allowedAccounts.includes(payload.targetAccount)) throw new HttpError(409, 'Confirmation amount or target account is invalid. Review the action and try again.');
        confirmation.targetAccount = payload.targetAccount;
        const expense = { id: uuid(), createdAt: now(), merchant: execution.result?.receipt?.merchant || null, date: execution.result?.receipt?.date || null, currency: execution.result?.receipt?.currency || null, amount: confirmation.amount, items: execution.result?.receipt?.items || [], categories: execution.result?.receipt?.categoryTotals || [], targetAccount: confirmation.targetAccount, sourceExecutionId: execution.id, sourceFile: execution.file?.originalName || null };
        state.expenses.unshift(expense);
        execution.result = { ...(execution.result || {}), expense };
        execution.status = 'completed'; execution.completedAt = now(); execution.confirmation = null;
        execution.modelsUsed = [...(execution.modelsUsed||[]), { capability:'expense tracker write', model:null, provider:'Local OrchAI store', executionMode:'LOCAL', status:'USED', completedAt:execution.completedAt }];
        const last = execution.steps.at(-1); if (last) { last.status = 'completed'; last.output = `Added ${execution.result.receipt.currencySymbol || ''}${expense.amount.toFixed(2)} to ${expense.targetAccount}`; last.finishedAt = now(); }
        appendLog(execution, `Expense ${expense.amount.toFixed(2)} added to ${expense.targetAccount} after explicit confirmation.`);
        updateHistory(execution); await saveState(); return send(response, 200, { execution, expense });
      }
      if (request.method === 'GET' && !action) return send(response, 200, { execution });
      throw new HttpError(405, 'Unsupported execution action.');
    }
    if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (await serveStatic(response, url.pathname)) return;
      if (await serveStatic(response, '/index.html')) return;
    }
    throw new HttpError(404, 'Route not found.');
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return send(response, status, { error: { message: error.message || 'Execution server error', type: error.name || 'Error' } });
  }
}

if (isMainServer) {
  const server = createServer((request, response) => { handle(request, response); });
  server.listen(PORT, '127.0.0.1', () => { console.log(`OrchAI local API ready at http://127.0.0.1:${PORT} · provider: ${providerStatus().provider}`); logProviderDiagnostic(); resumePersistedRuns(); });
  const shutdown = async () => { server.close(); await writeQueue; process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
