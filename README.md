# OrchAI

A no-code AI automation platform for Android. The user says what, and OrchAI decides how.

OrchAI accepts a natural-language task, identifies its input and the capabilities it needs, applies the selected device profile, and then runs each step with an installed local tool or a configured AI provider. Every run is saved with its plan, models used and result.

Status: prototype (ORCHAI ENGINE v0.9.4, demo).

## Overview

Using several AI models together on Android requires manual model selection, installation and chaining, while managing RAM, battery, storage and latency. OrchAI removes that work:

1. The user describes a task in plain language, or builds it visually.
2. OrchAI turns the request into an editable workflow.
3. OrchAI selects a model or local tool for each step and shows the reason.
4. OrchAI routes each step between local and cloud execution based on the device profile.
5. Steps that save data wait for user confirmation.
6. The run is stored with its status, steps, models and result.

Command Center is the automatic entry point. Workflow Builder is a separate manual editor.

## Features

- Natural-language requests with a single Generate & Execute action.
- Decision Panel that explains the chosen execution path.
- Editable, generated execution plan.
- Workflow Library, Workflow Builder, Model Center and Execution History.
- Input types: text, images, PDFs and audio (see Providers and Local capabilities for how each is handled).
- Device profiles: Normal, Low RAM, Low Battery, Offline.
- Confirmation before saving data (for example expenses).
- Expense Tracker with a PDF report download.
- Web and Android views of the same engine.

## Demo workflows

| Domain | Workflow | Result |
|---|---|---|
| Finance | Bill image to expense record | Extracted items, total, categories; saved after the user confirms amount and account |
| Education | Lecture audio to study notes and quiz | Study pack |
| Visual analysis | Plant photo to care plan | Care plan from color signals, labeled non-diagnostic |

All three run on the same engine.

## How it works

Request, AI understanding, workflow generation, model selection, resource check, execution, result.

Each execution keeps a shared context with the request inputs, the plan, the ordered step inputs and structured outputs, artifacts, variables, provider attempts and the final result. Before completion, the engine verifies that the required steps ran and produced the expected outputs.

## Run

```
npm install
npm run dev
```

`npm run dev` starts the Vite UI and the local Node API. `npm run build` builds the production UI, and `npm start` serves the built UI and API.

Uploads, generated files, workflows and execution history are stored in `storage/runtime`. Set `ORCHAI_STORAGE_DIR` to use another location.

## Providers and credentials

Set provider credentials only in `.env`. Never put keys in frontend files. `.env.example` lists the configuration names and non-secret defaults.

- Groq is the default real provider.
  - `openai/gpt-oss-120b` handles text reasoning and structured generation.
  - `qwen/qwen3.8-27b` handles images.
  - Whisper handles audio transcription.
- Gemini is the recovery provider. It is used only when Groq reports a recoverable provider, timeout, rate-limit or capability failure and `GEMINI_API_KEY` is configured. Set `ORCHAI_GEMINI_MODEL` to choose its fallback text model. It is not called when Groq succeeds.
- xAI is an optional text generation adapter, available when `XAI_API_KEY` is configured. It is not used for transcription or images.
- A provider shown as configured is only set up. A real request is recorded as used only after the provider returns a result. Failed requests show `REAL EXECUTION UNAVAILABLE` and are saved as failed attempts.

## Local capabilities

- Tesseract.js OCR for receipt images.
- PDF.js text extraction for text-based PDFs.
- pdf-lib for merging multiple PDFs and downloading the result.
- Local study-pack extraction.
- Plant-image color signals. These are uncertain and non-diagnostic.

Not installed: a local language model, a local speech-to-text model, and the Android companion. Tasks that need them fail with a clear message under the applicable profile.

## Device profiles and fallback

| Profile | Behavior |
|---|---|
| Normal | Allows configured providers and local tools |
| Offline | Blocks cloud calls |
| Low RAM | Uses the configured provider for ordinary text reasoning; prefers installed local OCR or image analysis where supported |
| Low Battery | Same as Low RAM |

Profiles are server-enforced presets. Live RAM and battery readings are not connected.

The provider router tries Groq first and uses Gemini only for recoverable provider failures when its key is configured. Ordinary application errors do not trigger fallback. Each provider attempt records the provider, model, attempt number, error, duration and fallback status. The router never alternates providers randomly and never calls both on a successful request.

## Validation

```
npm run build
npx tsc --noEmit
npm test
```

Tests cover input-derived OCR, local profile routing, study-pack extraction, plant-image uncertainty, multi-file PDF merging and persisted API execution.

## Limitations

- The Android companion is simulated, so real device actions are not available.
- Live RAM, battery and network sensing is not connected. Device profiles are presets.
- No local language model or local speech-to-text model is installed.
- Plant analysis is based on color signals only and is not a diagnosis.
- Extracted totals should be checked against the source document.
- No controlled evaluation of accuracy, latency or energy use has been done.

## Research basis

OrchAI builds on work in LLM reasoning and tool use, LLM-based orchestration, cost-aware model selection, and Android and on-device AI:

1. ReAct: Reasoning and Acting in LLMs
2. Toolformer: LMs Teach Themselves to Use Tools
3. HuggingGPT: Solving AI Tasks with LLM + Models
4. FrugalGPT: Cost-aware LLM Use
5. Android AccessibilityService Reference
6. Android Intents and Intent Filters
7. Gemini API Documentation
8. Google AI Edge: On-device AI

Compared platforms: [Apple Shortcuts](https://support.apple.com/guide/shortcuts), [Tasker](https://tasker.joaoapps.com), [MacroDroid](https://www.macrodroid.com), [n8n](https://n8n.io).
