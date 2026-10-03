# ORCHAI

ORCHAI accepts a natural-language task, identifies its input and required capabilities, applies the selected device policy, then uses an installed local tool or a configured provider. Command Center is the automatic user entry point; Workflow Builder is the separate manual editor.

## Run

```bash
npm install
npm run dev
```

The development command starts the Vite UI and local Node API. `npm run build` builds the production UI; `npm start` serves the built UI and API. Local uploads, generated files, workflows, and execution history use `storage/runtime` unless `ORCHAI_STORAGE_DIR` points elsewhere.

## Providers and credentials

Set provider credentials only in `.env`; never put keys in frontend files. `.env.example` contains configuration names and non-secret defaults only.

- Groq is the default real provider. `openai/gpt-oss-120b` handles text reasoning and structured generation; `qwen/qwen3.8-27b` handles images; Whisper handles audio transcription.
- Gemini remains available as the recovery provider when Groq reports a recoverable provider, timeout, rate-limit, or capability failure and `GEMINI_API_KEY` is configured. Set `ORCHAI_GEMINI_MODEL` to choose its fallback text model. It is not called for normal Groq success paths. Its text, image, PDF vision, and audio adapters remain server-side.
- xAI is available as an optional text generation adapter when `XAI_API_KEY` is configured. It is not treated as a transcription or image adapter.
- Provider status means configured; a successful real request is recorded as used only after the provider returns a result. Failed requests show `REAL EXECUTION UNAVAILABLE` and are saved as failed attempts.

## Installed local capabilities

- Tesseract.js OCR for receipt images.
- PDF.js extraction for text-based PDFs.
- pdf-lib for merging multiple PDFs and downloading the generated file.
- Local study-pack extraction and plant-image color signals. These outputs are identified as local processing; plant color signals are explicitly uncertain and non-diagnostic.
- No local language model, local speech-to-text model, or Android companion is installed. Tasks requiring those capabilities fail clearly under the applicable profile.

## Device profiles and fallback

Normal permits configured providers and local tools. Offline blocks cloud calls. Low RAM and Low Battery select the configured provider for ordinary text reasoning and prefer installed local OCR or image analysis where supported. Groq vision and Whisper transcription are used when their required inputs are supplied. These are server-enforced policy presets; live RAM and battery sensor readings are not connected.

The centralized provider router tries Groq first, then uses Gemini only for recoverable provider failures when its key is configured. Ordinary application errors do not trigger fallback. Each actual provider attempt records provider, model, attempt number, error, duration, and fallback status. Provider selection does not alternate randomly or call both providers on successful requests.

Each execution persists a shared context with request inputs, plan, ordered step inputs and structured outputs, artifacts, variables, provider attempts, and final result. Before completion, the engine verifies required steps and expected outputs.

## Validation

```bash
npm run build
npx tsc --noEmit
npm test
```

Tests cover input-derived OCR, local profile routing, study-pack extraction, plant-image uncertainty, multi-file PDF merging, and persisted API execution.
