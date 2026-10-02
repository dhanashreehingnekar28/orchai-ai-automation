# OrchAI

OrchAI is a frontend-only, deterministic prototype of a general-purpose Android AI automation platform. It turns a natural-language request into an editable workflow, chooses models per step, routes around device constraints, and pauses before sensitive actions.

## Run locally

```bash
npm install
npm run dev
```

Build the production bundle with `npm run build`.

## Routes

- `/` — landing page and orchestration story
- `/app` — command center and prompt-to-workflow entry
- `/app/workflows` — workflow library and previews
- `/app/builder` — editable workflow canvas, decision panel, and JSON view
- `/app/models` — prototype capability registry
- `/app/device` — simulated resources, device profiles, and live routing
- `/app/history` — in-memory execution history
- `/app/execution` — step-by-step demo execution and shared controls
- `/app/architecture` — target architecture, feasibility, impact/scaling, and safety
- `/app/settings` — demo speed, failure injection, and reset controls

## Demo walkthrough

1. Open the command center and choose **Analyze my bill** (or paste the full handwritten bill request).
2. Inspect the editable expense workflow and its model choice. The preferred local vision model is rejected because it needs more usable RAM; Gemini Flash is selected for the combined vision and OCR requirement.
3. Run the workflow. Pause, resume, or stop it from the execution view or notification. Confirm the exact ₹1,248.50 Expense Tracker action to see the result.
4. Run it again to see the bill extraction cache indicator. Change the device profile to **Low RAM** or **Offline** to see model routing change.
5. Select **Study Pack** from the library to see speech-to-text, concept extraction, notes, and an expandable five-question quiz. Select **Plant Analysis** for the third executable workflow.
6. Open **Architecture & impact** to explore live workflow counts and device profile changes alongside the impact, viability, scaling, and safety views inspired by the supplied reference slides.

## What is simulated

Device RAM, battery, storage, network, Android camera/file/intent access, model availability and execution, generated content, model downloads, caching, and history are deterministic browser simulations. The browser does not control Android hardware. Sensitive external writes require an explicit confirmation in the prototype.

## Backend integration seams

The workflow and model definitions live in `src/engine.ts`; deterministic model placement is in `routeStep`. `src/store.ts` holds the shared session state. Replace the prototype registry and local state transitions with async service adapters for a FastAPI/Gemini orchestrator, persist workflow JSON and run history in Supabase, and map Android camera, files, notifications, and intents to a native Kotlin/React Native shell. Keep model credentials backend-held and retain the confirmation gate for account writes.
