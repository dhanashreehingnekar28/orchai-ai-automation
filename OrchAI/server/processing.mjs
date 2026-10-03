import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const englishData = require('@tesseract.js-data/eng');

const stopWords = new Set(('about after again also another around because before being between both could does each from further have having into itself just more most other over same should some such than that their them then there these they this those through under until very what when where which while with would your you lecture notes concept concepts important explain make create into from were will can all any are and the for was with have has had not but use using used based been being its his her our').split(/\s+/));
let ocrWorker;

export async function recognizeImage(buffer, onProgress = () => {}) {
  if (!ocrWorker) ocrWorker = await createWorker('eng', 1, { langPath: englishData.langPath, gzip: englishData.gzip, logger: event => { if (event.status === 'recognizing text') onProgress(Math.round((event.progress || 0) * 100)); } });
  const enhanced = await sharp(buffer).rotate().resize({ width: 1200, withoutEnlargement: false }).grayscale().normalize().sharpen().png().toBuffer();
  const result = await ocrWorker.recognize(enhanced);
  const text = result.data.text?.trim() || '';
  if (!text) throw new Error('No readable text was found. Try a sharper image with the full bill in frame.');
  return { text, confidence: Math.round(result.data.confidence || 0), provider: 'Tesseract.js · local OCR', model: 'Tesseract English OCR' };
}

const excludedLine = /\b(sub.?total|total|tax|vat|gst|invoice|receipt|payment|visa|mastercard|cash|change|balance|date|time|phone|tel|register|server|thank|visit|feedback|address|street|zip|discount|tip|gratuity|order|table|card|auth|approval|subtotal)\b/i;
const moneyRE = /(?:[$₹€£]\s*)?(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|-?\d+\.\d{2})/g;
const amount = value => Number(String(value).replace(/,/g, ''));

export function parseReceiptText(text, confidence = 0) {
  const lines = text.split(/\r?\n/).map(x => x.replace(/[|_]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const merchant = lines.find(line => /[a-z]{3,}/i.test(line) && !excludedLine.test(line) && !/\d{3,}/.test(line))?.slice(0, 90) || null;
  const dateMatch = text.match(/\b(\d{1,2}[/-]\d{1,2}[/-](?:\d{2}|\d{4})|\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b/);
  const currency = /₹|\bINR\b|\bRs\.?/i.test(text) ? 'INR' : /€/.test(text) ? 'EUR' : /£/.test(text) ? 'GBP' : /\$|\bUSD\b/i.test(text) ? 'USD' : null;
  const candidates = [];
  for (const line of lines) {
    if (excludedLine.test(line)) continue;
    const matches = [...line.matchAll(moneyRE)];
    if (!matches.length) continue;
    const match = matches.at(-1);
    const value = amount(match[1]);
    const description = line.slice(0, match.index).replace(/^[\s\d.x×*-]+/, '').replace(/\s+\d+\s*$/, '').trim();
    if (!description || description.length < 2 || !/[a-z]/i.test(description) || value <= 0 || value > 1_000_000) continue;
    const qtyMatch = line.match(/^\s*(\d+(?:\.\d+)?)\s+(?=[A-Za-z])/);
    const quantity = qtyMatch ? Number(qtyMatch[1]) : 1;
    if (quantity > 1000 || quantity <= 0) continue;
    candidates.push({ description: description.slice(0, 100), quantity, amount: Number(value.toFixed(2)), category: 'Uncategorized' });
  }
  const items = candidates.filter((item, index) => candidates.findIndex(other => other.description.toLowerCase() === item.description.toLowerCase() && other.amount === item.amount) === index);
  const lineItemsTotal = Number(items.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
  const findLabelAmount = label => {
    const line = lines.find(value => label.test(value));
    if (!line) return null;
    const matches = [...line.matchAll(moneyRE)];
    return matches.length ? amount(matches.at(-1)[1]) : null;
  };
  const receiptTotal = findLabelAmount(/\b(total|amount due|balance due)\b/i);
  const tax = findLabelAmount(/\b(tax|vat|gst)\b/i);
  const subtotal = findLabelAmount(/\b(sub.?total)\b/i);
  const calculatedTotal = Number((lineItemsTotal + (tax || 0)).toFixed(2));
  const discrepancy = receiptTotal == null ? null : Number((calculatedTotal - receiptTotal).toFixed(2));
  const lineItemsDiscrepancy = subtotal == null ? null : Number((lineItemsTotal - subtotal).toFixed(2));
  const categoryTotals = Object.entries(items.reduce((result, item) => { result[item.category] = (result[item.category] || 0) + item.amount; return result; }, {})).map(([category, total]) => ({ category, total: Number(total.toFixed(2)) }));
  if (tax != null && tax > 0) categoryTotals.push({ category: 'Tax', total: Number(tax.toFixed(2)) });
  const currencySymbol = { INR: '₹', USD: '$', EUR: '€', GBP: '£' }[currency] || '';
  const discrepancyFlag = discrepancy != null && Math.abs(discrepancy) > 0.02 ? 'calculated total differs from printed total' : lineItemsDiscrepancy != null && Math.abs(lineItemsDiscrepancy) > 0.02 ? 'extracted line items differ from printed subtotal' : discrepancy == null ? 'receipt total not found' : 'totals match';
  return { merchant, date: dateMatch?.[1] || null, items, lineItemsTotal, subtotal, tax, receiptTotal, calculatedTotal, discrepancy, lineItemsDiscrepancy, discrepancyFlag, categoryTotals, currency, currencySymbol, ocrConfidence: confidence, rawText: text };
}

export function receiptFromProvider(data, rawText = '') {
  const source = data?.items;
  if (!Array.isArray(source) || !source.length) throw new Error('The configured vision model did not return any receipt line items.');
  const items = source.map(row => {
    const description = String(row.description || row.name || '').trim();
    const value = Number(row.amount ?? row.total ?? row.unit_price);
    const quantity = Number(row.quantity || 1);
    if (!description || !Number.isFinite(value) || value < 0 || !Number.isFinite(quantity) || quantity <= 0) return null;
    return { description, quantity, amount: Number(value.toFixed(2)), category: String(row.category || '').trim() || 'Uncategorized' };
  }).filter(Boolean);
  if (!items.length) throw new Error('The configured vision model returned unusable receipt items.');
  const lineItemsTotal = Number(items.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
  const receiptTotal = data.receiptTotal == null ? null : Number(data.receiptTotal);
  const subtotal = data.subtotal == null ? null : Number(data.subtotal);
  const tax = data.tax == null ? null : Number(data.tax);
  const calculatedTotal = Number((lineItemsTotal + (tax || 0)).toFixed(2));
  const discrepancy = receiptTotal == null ? null : Number((calculatedTotal - receiptTotal).toFixed(2));
  const lineItemsDiscrepancy = subtotal == null ? null : Number((lineItemsTotal - subtotal).toFixed(2));
  const categoryTotals = Object.entries(items.reduce((result, item) => { result[item.category] = (result[item.category] || 0) + item.amount; return result; }, {})).map(([category, total]) => ({ category, total: Number(total.toFixed(2)) }));
  if (tax != null && tax > 0) categoryTotals.push({ category: 'Tax', total: Number(tax.toFixed(2)) });
  const discrepancyFlag = discrepancy != null && Math.abs(discrepancy) > 0.02 ? 'calculated total differs from printed total' : lineItemsDiscrepancy != null && Math.abs(lineItemsDiscrepancy) > 0.02 ? 'extracted line items differ from printed subtotal' : discrepancy == null ? 'receipt total not found' : 'totals match';
  return { merchant: data.merchant || null, date: data.date || null, items, lineItemsTotal, subtotal, tax, receiptTotal, calculatedTotal, discrepancy, lineItemsDiscrepancy, discrepancyFlag, categoryTotals, currency: data.currency || null, currencySymbol: data.currencySymbol || '', ocrConfidence: null, rawText };
}

function sentenceList(text) { return text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9“"'])/).map(x => x.trim()).filter(x => x.length >= 35); }
function conceptsFromText(text, count = 5) {
  const terms = (text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []).filter(word => !stopWords.has(word));
  const counts = new Map();
  for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
  const phrases = new Map();
  const tokens = text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const phrase = `${tokens[i]} ${tokens[i + 1]}`;
    if (!stopWords.has(tokens[i]) && !stopWords.has(tokens[i + 1]) && phrase.length > 8) phrases.set(phrase, (phrases.get(phrase) || 0) + 1);
  }
  const ranked = [...phrases.entries()].map(([term, n]) => ({ term, count: n, score: n * 1.65 + term.length / 30 })).concat([...counts.entries()].map(([term, n]) => ({ term, count: n, score: n + (term.length > 8 ? .15 : 0) }))).sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const picked = [];
  for (const entry of ranked) {
    if (picked.some(item => item.term.includes(entry.term) || entry.term.includes(item.term))) continue;
    picked.push({ term: entry.term, occurrences: entry.count, evidence: sentenceList(text).find(sentence => sentence.toLowerCase().includes(entry.term)) || '' });
    if (picked.length === count) break;
  }
  return picked;
}

export function createStudyPack(text, transcript = text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const words = normalized.match(/[\p{L}\p{N}'-]+/gu) || [];
  if (words.length < 25) throw new Error('There is not enough readable lecture content. Provide a longer text, document, or clear recording.');
  const concepts = conceptsFromText(normalized, 5);
  const sentences = sentenceList(normalized);
  if (!concepts.length || !sentences.length) throw new Error('The source does not contain enough structured language to build useful notes and questions.');
  const notes = sentences.map((sentence, index) => ({ sentence, score: concepts.reduce((score, concept) => score + (sentence.toLowerCase().includes(concept.term) ? 2 : 0), 0) - index * .01 })).sort((a, b) => b.score - a.score).slice(0, Math.min(8, Math.max(4, Math.ceil(sentences.length / 3)))).map(item => item.sentence);
  const summary = [...notes].slice(0, Math.min(3, notes.length)).join(' ');
  const questions = Array.from({ length: 5 }, (_, index) => {
    const concept = concepts[index % concepts.length];
    const answer = concept.evidence || sentences[index % sentences.length];
    return { question: `How does the source explain “${concept.term}”?`, evidence: answer, answer };
  });
  return { transcript, summary, keyConcepts: concepts.map(concept => ({ name: concept.term, evidence: concept.evidence })), studyNotes: notes, quizQuestions: questions, wordCount: words.length, provider: 'Local extractive analysis', model: 'Local text analysis · no generative model configured', limitations: 'Notes and questions are derived from source sentences and keyword frequency; no external generative model was used.' };
}

export async function inspectPlantImage(buffer) {
  const original = await sharp(buffer).metadata();
  const { data, info } = await sharp(buffer).rotate().resize({ width: 120, height: 120, fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const totals = { green: 0, yellow: 0, brown: 0, dark: 0, pixels: info.width * info.height };
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (g > r * 1.08 && g > b * 1.04 && g > 36) totals.green++;
    if (r > 105 && g > 85 && g > b * 1.18 && r < g * 1.45 && r - g < 48) totals.yellow++;
    if (r > 45 && r < 185 && r > g * 1.18 && g > b * 1.08 && r - b > 22) totals.brown++;
    if (r < 70 && g < 75 && b < 70) totals.dark++;
  }
  const ratio = key => Number((totals[key] / Math.max(1, totals.pixels)).toFixed(3));
  const signals = { greenPixels: ratio('green'), yellowPixels: ratio('yellow'), brownPixels: ratio('brown'), darkPixels: ratio('dark'), width: info.width, height: info.height };
  const lowQuality = Math.min(original.width || 0, original.height || 0) < 100;
  const stress = signals.yellowPixels + signals.brownPixels;
  let observation, possibleIssue, nextSteps;
  if (lowQuality) {
    observation = 'The uploaded image has limited resolution for leaf-level assessment.';
    possibleIssue = 'Inconclusive image; no disease can be identified from this resolution.';
    nextSteps = ['Upload a closer, well-lit photo of the leaf surface.', 'Include both affected and healthy leaves for comparison.'];
  } else if (stress > .16) {
    observation = `The image contains visible yellow/brown-toned pixels (${Math.round(stress * 100)}% of sampled pixels); background and lighting can affect this estimate.`;
    possibleIssue = 'Visible discoloration detected; no specific plant disease is identified by this local color check.';
    nextSteps = ['Check soil moisture and drainage before changing watering.', 'Inspect both sides of leaves for pests or spreading lesions.', 'Improve airflow and avoid wetting foliage; compare new growth over several days.'];
  } else if (signals.greenPixels > .15) {
    observation = `Green foliage is visible (${Math.round(signals.greenPixels * 100)}% of sampled pixels); no strong discoloration signal was detected by the local image check.`;
    possibleIssue = 'Inconclusive: this local image check cannot rule out plant disease.';
    nextSteps = ['Monitor new growth and inspect leaf undersides.', 'Keep watering consistent and use a pot with drainage.', 'For persistent or spreading symptoms, request review with a plant expert or configured vision model.'];
  } else {
    observation = 'A clear leaf surface was not detected in this image.';
    possibleIssue = 'Inconclusive image; upload a closer photo centered on the affected leaf.';
    nextSteps = ['Photograph one affected leaf in natural, even light.', 'Avoid strong backlighting and include the whole leaf.'];
  }
  return { description: 'Local image processing measured broad color proportions; it did not identify plant species or a disease.', likelyCause: 'Cause cannot be identified from color proportions alone; check watering, light, drainage, pests, and image quality.', observation, possibleIssue, symptoms: observation, treatmentInformation: 'General reference: first inspect light exposure, soil moisture, drainage, and pests. Remove only clearly dead material and avoid applying pesticides until the cause is better established.', recommendedNextSteps: nextSteps, carePlan: nextSteps, confidence: lowQuality ? 0.08 : stress > .16 ? 0.18 : .12, visualSignals: signals, provider: 'Local image feature analysis', model: 'Sharp pixel-color analysis · non-diagnostic', limitations: 'This local fallback measures broad color proportions only. It does not identify a species or diagnose a disease.' };
}

