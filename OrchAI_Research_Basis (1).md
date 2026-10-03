# OrchAI: Research Basis and Comparison

This file lists, paper by paper, what OrchAI took from each reference, the key takeaways, and how OrchAI differs. It also compares OrchAI with existing automation platforms.

---

## 1. Summary Table

| Ref | Source | Area | Key idea | What OrchAI took |
|---|---|---|---|---|
| [1] | ReAct: Reasoning and Acting in LLMs | Reasoning + acting | A model interleaves reasoning steps with actions | Plan-then-act loop; visible step-by-step trace |
| [2] | Toolformer: LMs Teach Themselves to Use Tools | Tool use | A model learns when and how to call external tools | Decision per step to use a model or a tool (OCR, calculation) |
| [3] | HuggingGPT: Solving AI Tasks with LLM + Models | Orchestration | An LLM plans a task and delegates sub-tasks to specialist models | Main pipeline: plan, select model, execute, return result |
| [4] | FrugalGPT: Cost-aware LLM Use | Cost-aware routing | Choose which model handles a query to reduce cost | Per-step model/tool selection under constraints |
| [5] | Android AccessibilityService Reference | Device actions | Android service that can observe the screen and act for the user | Candidate mechanism for device actions |
| [6] | Android Intents and Intent Filters | Device actions | Messages that ask another app or component to do something | Candidate mechanism for launching actions across apps |
| [7] | Gemini API Documentation | Cloud models | Cloud API for multimodal models | Candidate second cloud provider |
| [8] | Google AI Edge: On-device AI | On-device models | Tools for running models on the device | Candidate for local language and speech models |

---

## 2. Paper-wise Content

### [1] ReAct: Reasoning and Acting in LLMs

**Core idea.** A language model alternates between reasoning steps and actions, so reasoning guides the next action and action results update the reasoning.

**Key takeaways.**
- Combining reasoning and acting works better than either alone for multi-step tasks.
- A written trace of thoughts and actions makes the process easier to inspect.

**What OrchAI took.**
- The plan-then-act structure of a request.
- The execution trace, which shows each step, the model used and the status.

**How OrchAI differs.** OrchAI shows the plan to the user as an editable workflow before and during execution, and it adds device-profile routing and confirmation steps.

**Status.** Used.

---

### [2] Toolformer: Language Models Teach Themselves to Use Tools

**Core idea.** A language model learns on its own when to call external tools, which tool to call, and how to use the result.

**Key takeaways.**
- Models are weak at some tasks (such as exact calculation) where a tool is more reliable.
- The decision to use a tool can be part of the model's own behavior.

**What OrchAI took.**
- The idea that each step may use a model or a deterministic tool.
- Local tools for OCR, PDF text extraction, plant color signals and file processing.
- A calculation request that is verified independently.

**How OrchAI differs.** Toolformer trains the model to call tools. OrchAI does not train a model. It plans the steps and selects the tool for each one.

**Status.** Used.

---

### [3] HuggingGPT: Solving AI Tasks with LLM + Models

**Core idea.** A language model acts as a controller. It plans the task, selects specialist models for the sub-tasks, runs them, and combines the results.

**Key takeaways.**
- A single language model can coordinate many specialist models.
- The work divides into four stages: planning, model selection, execution, and response.

**What OrchAI took.**
- The overall pipeline: request, understanding, workflow generation, model selection, execution, result.
- The idea of passing each step's output to the next step.

**How OrchAI differs.**
- OrchAI runs on a mobile device and applies a device profile (Normal, Low RAM, Low Battery, Offline) to the choice.
- The plan is editable by the user.
- Steps that save data require user confirmation.
- Each run is recorded with the model, provider and status of every step.

**Status.** Used. This is the closest related work.

---

### [4] FrugalGPT: Cost-aware LLM Use

**Core idea.** Reduce the cost of using language models by choosing which model answers each query instead of always using the largest model.

**Key takeaways.**
- Not every query needs the most expensive model.
- Routing and model choice can lower cost while keeping quality acceptable.

**What OrchAI took.**
- The principle of choosing a model or tool for each step instead of one model for everything.
- The Decision Panel, which shows the candidates, the choice and the reason.

**How OrchAI differs.** OrchAI routes by device constraints and installed tools (local or cloud), not by price. It does not yet use a cascade of models.

**Status.** Partly used.

---

### [5] Android AccessibilityService Reference

**Core idea.** An Android service that can observe what is on screen and perform actions on behalf of the user. It must be enabled explicitly by the user.

**Key takeaways.**
- It is a mechanism for acting inside other apps.
- It gives broad access, so actions should be controlled and confirmed.

**What OrchAI took.**
- A candidate way to carry out device actions.
- The design rule that sensitive actions should ask for confirmation.

**Status.** Planned. The Android companion is simulated, so device actions are not available.

---

### [6] Android Intents and Intent Filters

**Core idea.** An intent is a message that asks another app or component to perform an action. Intent filters declare what a component can handle.

**Key takeaways.**
- Intents are the standard way to start actions across apps.
- They are simpler and narrower than controlling the screen.

**What OrchAI took.** A candidate way to launch actions in other apps.

**Status.** Planned. Not implemented in the current prototype.

---

### [7] Gemini API Documentation

**Core idea.** A cloud API for multimodal models.

**Key takeaways.**
- It is an alternative cloud back end for text and image tasks.

**What OrchAI took.** A candidate second cloud provider.

**Status.** Not used. The prototype uses Groq with openai/gpt-oss-120b. No second provider is configured.

---

### [8] Google AI Edge: On-device AI

**Core idea.** Tools and guidance for running AI models on the device.

**Key takeaways.**
- On-device execution supports offline use and avoids cloud calls.

**What OrchAI took.** A candidate path for the local language model and local speech-to-text model.

**Status.** Not used. Both local models are listed as NOT INSTALLED.

---

## 3. Capability Comparison: Research Sources vs OrchAI

| Capability | [1] ReAct | [2] Toolformer | [3] HuggingGPT | [4] FrugalGPT | OrchAI |
|---|---|---|---|---|---|
| Reasoning + acting loop | Yes | No | Partial | No | Yes |
| Calls external tools | Yes | Yes | Yes | No | Yes |
| Plans a multi-step task | Partial | No | Yes | No | Yes |
| Selects a model per step | No | No | Yes | Yes | Yes |
| Cost or resource-aware choice | No | No | No | Yes (cost) | Partial (device presets) |
| Local vs cloud routing | No | No | No | No | Yes (by device profile) |
| User can edit the plan | No | No | No | No | Yes |
| Confirmation before saving data | No | No | No | No | Yes |
| Execution trace | Yes | No | Partial | No | Yes |
| Device actions on Android | No | No | No | No | Planned |

Notes:
- Entries for [1] to [4] describe the main focus of each paper, not every detail.
- "Partial" for OrchAI resource-awareness means the profiles are presets. Live RAM, battery and network readings are not connected.

---

## 4. Comparison with Existing Platforms

| Aspect | Apple Shortcuts | Tasker | MacroDroid | n8n | OrchAI |
|---|---|---|---|---|---|
| Platform | Apple devices | Android | Android | Web / server | Android view of a web app |
| How a workflow is made | User builds it from actions | User builds tasks and triggers | User builds macros | User builds it from nodes | Generated from plain language; editable |
| Who chooses the AI model | User | User | User | User | OrchAI, per step |
| Local vs cloud decision | Manual | Manual | Manual | Manual | Based on device profile |
| Confirmation before saving data | Not a built-in rule | Not a built-in rule | Not a built-in rule | Not a built-in rule | Yes, for saving steps |
| Run history with model per step | No | No | No | Execution log (not per AI model) | Yes (Model center, Execution history) |
| Real Android device actions | No | Yes | Yes | No | Not yet (companion simulated) |

Notes:
- Entries for the existing platforms are general descriptions. Check each product's current documentation before publishing exact claims.
- Real device actions are a strength of Tasker and MacroDroid. OrchAI does not match them yet.

---

## 5. Key Takeaways

1. The planner-and-executor pattern from [3] is the base of OrchAI.
2. Reasoning with visible actions [1] motivates the editable plan and the execution trace.
3. Using tools where models are weak [2] motivates local tools such as OCR and calculation checks.
4. Choosing a model per step [4] motivates the Decision Panel and device-based routing.
5. Android mechanisms [5][6] are the planned route for real device actions, with confirmation for sensitive ones.
6. Cloud and on-device options [7][8] define the next steps: a second provider and local models.
7. Compared with existing platforms, OrchAI's difference is generating the workflow from plain language and choosing the model for each step. Its gap is real Android device actions.

---

## 6. Open Items

- Live RAM, battery and network sensing is not connected.
- The Android companion is simulated.
- No second cloud provider and no local language or speech model are installed.
- No controlled evaluation has been done.

Note: the paper summaries above are short paraphrases. Check them against the original papers and documentation before citing them.
