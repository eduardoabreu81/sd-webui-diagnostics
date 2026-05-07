<div align="center">

# 🔍 SD-WebUI Diagnostics

[![Forge Neo](https://img.shields.io/badge/Forge-Neo-blue)](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> Lightweight performance profiler for Stable Diffusion WebUI Forge Neo.
> Find out which extensions are slowing down your workflow.

</div>

---

## What is this?

SD-WebUI Diagnostics is a browser-side extension that lives inside your Stable Diffusion WebUI and measures, in real time, what is making the interface slow. It answers questions like:

- "Which extension is blocking the prompt box for 8 seconds?"
- "How much memory is each extension eating?"
- "What JavaScript error crashed the UI today?"
- "Why is my first paint taking 10 seconds?"

It does **not** touch Python, CUDA, or model inference. It only looks at the **frontend** — the browser tab where you type prompts and click buttons.

---

## What it measures

| Metric | Why it matters |
|---|---|
| **Startup time per extension** | See exactly how many seconds each extension adds to the initial page load |
| **Input delay (INP)** | Detect when keystrokes or clicks are stuck waiting in the browser queue |
| **Layout shifts (CLS)** | Spot which UI elements are jumping around and annoying you |
| **Memory usage** | Track RAM growth over time to catch memory leaks |
| **Console errors** | Collect JavaScript errors from all extensions in one place |
| **Heavy event handlers** | Identify which functions freeze the interface when you type or click |

---

## How it works

SD-WebUI Diagnostics is injected into the Gradio page like any other extension. It works by wrapping the standard WebUI hooks and browser APIs with lightweight timers:

1. **Intercept startup hooks** — wraps `onUiLoaded`, `onUiUpdate`, and the Gradio mutation observer so it knows when each extension starts and finishes initializing.
2. **Wrap event listeners** — wraps `addEventListener` on key targets (prompt textareas, buttons, sliders) to measure how long handlers take.
3. **Performance Observer** — listens to the browser's native `PerformanceObserver` for INP, CLS, and LCP events.
4. **Console interceptor** — captures `console.error`, `console.warn`, and unhandled exceptions so nothing is lost.
5. **Memory snapshots** — reads `performance.memory` (Chrome) every few seconds to build a timeline.

All data is collected locally in the browser. Nothing is sent to any server.

---

## What you see

A small floating panel in the bottom-right corner of the WebUI (collapsible) shows:

- **Live INP meter** — turns red when typing starts lagging
- **Extension startup chart** — horizontal bars showing load time per extension
- **Error feed** — last 20 console errors, clickable to expand stack traces
- **Memory timeline** — simple line chart of RAM usage over the last 5 minutes
- **Export button** — downloads a `.json` report you can attach to GitHub issues

When the panel is collapsed, only a tiny pill shows the current INP and error count.

---

## Installation

1. Open your SD WebUI (A1111, Forge, reForge, or Forge Neo)
2. Go to **Extensions** → **Install from URL**
3. Paste: `https://github.com/eduardoabreu81/sd-webui-diagnostics`
4. Click **Install** and reload the WebUI
5. The diagnostics panel appears automatically in the bottom-right corner

> ⚠️ Best experience on Forge Neo / Gradio 4. Compatible with A1111 and reForge (Gradio 3) with limited Gradio-call detection.

---

## When to use it

| Scenario | What to check |
|---|---|
| "My prompt box lags when I type" | Open the panel, look at INP and the "Slow Event Handlers" tab |
| "The WebUI takes forever to open" | Check the "Startup" tab — the longest bar is the culprit |
| "The UI froze and I don't know why" | Check the "Errors" tab for red stack traces |
| "Memory usage keeps growing" | Check the "Memory" timeline for spikes |
| "I'm reporting a bug to an extension author" | Click **Export JSON** and attach the file to your issue |

---

## Privacy & Data

- **Zero network calls.** All metrics are computed inside your browser.
- **Zero logging to disk.** Data lives only in RAM while the tab is open.
- **Export is manual.** The JSON report is only generated when you click the button.

---

## Limitations

- Only measures the **browser tab** (frontend). It cannot see Python backend delays, model loading, or CUDA operations.
- Extensions that inject code directly into the DOM without using standard hooks may be harder to profile precisely.
- Memory readings are Chrome-only (`performance.memory` is not standardized).
- Heavy profiling adds a tiny overhead (~1-2%). You can disable the extension when not needed.

---

## Credits

- Idea born from debugging [sd-webui-tagcomplete-neo](https://github.com/eduardoabreu81/sd-webui-tagcomplete-neo) performance issues
- Built for the Forge Neo community

---

## License

MIT — see [LICENSE](LICENSE)
