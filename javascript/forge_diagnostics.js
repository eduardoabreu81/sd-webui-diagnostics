/**
 * Forge Diagnostics — Lightweight frontend profiler for Forge Neo.
 *
 * Measures startup times, input delay (INP), layout shifts (CLS),
 * memory usage, and console errors without touching the Python backend.
 */

(function () {
    "use strict";

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    const metrics = {
        startup: [],          // {name, start, end, duration}
        inp: [],              // {value, target, timestamp}
        cls: 0,               // cumulative layout shift score
        lcp: 0,               // largest contentful paint
        memory: [],           // {used, total, timestamp}
        errors: [],           // {type, message, stack, timestamp}
        handlers: [],         // {event, target, duration, fnName}
    };

    let panelVisible = false;
    let panelEl = null;
    let memoryInterval = null;

    // ------------------------------------------------------------------
    // Utils
    // ------------------------------------------------------------------
    const now = () => performance.now();
    const fmtMs = (n) => (n < 1000 ? `${n.toFixed(0)} ms` : `${(n / 1000).toFixed(2)} s`);

    // ------------------------------------------------------------------
    // Console interceptor
    // ------------------------------------------------------------------
    const origError = console.error;
    const origWarn = console.warn;

    console.error = function (...args) {
        metrics.errors.push({ type: "error", message: args.join(" "), stack: new Error().stack, timestamp: now() });
        origError.apply(console, args);
    };

    console.warn = function (...args) {
        metrics.errors.push({ type: "warn", message: args.join(" "), stack: new Error().stack, timestamp: now() });
        origWarn.apply(console, args);
    };

    window.addEventListener("error", (e) => {
        metrics.errors.push({ type: "exception", message: e.message, stack: e.error?.stack || "", timestamp: now() });
    });

    window.addEventListener("unhandledrejection", (e) => {
        metrics.errors.push({ type: "rejection", message: e.reason, stack: "", timestamp: now() });
    });

    // ------------------------------------------------------------------
    // Performance Observer — INP, LCP, CLS
    // ------------------------------------------------------------------
    try {
        const obs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (entry.entryType === "web-vitals-inp" || (entry.entryType === "event" && entry.duration > 50)) {
                    metrics.inp.push({ value: entry.duration, target: entry.target?.nodeName || "", timestamp: now() });
                    updateInpBadge();
                }
                if (entry.entryType === "layout-shift" && !entry.hadRecentInput) {
                    metrics.cls += entry.value;
                    updateClsBadge();
                }
                if (entry.entryType === "largest-contentful-paint") {
                    metrics.lcp = entry.startTime;
                    updateLcpBadge();
                }
            }
        });

        // INP via Event Timing API (Chrome 96+)
        if ("PerformanceEventTiming" in window) {
            obs.observe({ type: "event", buffered: true, durationThreshold: 50 });
        }
        // Layout shifts
        if ("LayoutShift" in window) {
            obs.observe({ type: "layout-shift", buffered: true });
        }
        // LCP
        if ("LargestContentfulPaint" in window) {
            obs.observe({ type: "largest-contentful-paint", buffered: true });
        }
    } catch (e) {
        console.error("[Forge Diagnostics] PerformanceObserver init failed:", e);
    }

    // ------------------------------------------------------------------
    // Memory polling (Chrome-only)
    // ------------------------------------------------------------------
    function startMemoryPolling() {
        if (!performance.memory) return;
        memoryInterval = setInterval(() => {
            const m = performance.memory;
            metrics.memory.push({
                used: m.usedJSHeapSize,
                total: m.totalJSHeapSize,
                limit: m.jsHeapSizeLimit,
                timestamp: now(),
            });
            // Keep last 300 samples (~5 min at 1s interval)
            if (metrics.memory.length > 300) metrics.memory.shift();
            updateMemoryBadge();
        }, 1000);
    }

    // ------------------------------------------------------------------
    // Startup timing — wrap global hooks
    // ------------------------------------------------------------------
    function wrapHook(name, fn) {
        if (typeof fn !== "function") return fn;
        return function (...args) {
            const start = now();
            const result = fn.apply(this, args);
            const end = now();
            metrics.startup.push({ name, start, end, duration: end - start });
            updateStartupBadge();
            return result;
        };
    }

    // Wrap after a short delay so other scripts have time to register
    setTimeout(() => {
        if (window.onUiLoaded) window.onUiLoaded = wrapHook("onUiLoaded", window.onUiLoaded);
        if (window.onUiUpdate) window.onUiUpdate = wrapHook("onUiUpdate", window.onUiUpdate);
    }, 0);

    // ------------------------------------------------------------------
    // Event handler profiler
    // ------------------------------------------------------------------
    const origAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (!listener || typeof listener !== "function") {
            return origAddEventListener.call(this, type, listener, options);
        }
        const wrapped = function (event) {
            const start = now();
            try {
                listener.call(this, event);
            } finally {
                const duration = now() - start;
                if (duration > 50) {
                    metrics.handlers.push({
                        event: type,
                        target: event.target?.nodeName || "",
                        duration,
                        fnName: listener.name || "(anonymous)",
                        timestamp: now(),
                    });
                    updateHandlerBadge();
                }
            }
        };
        return origAddEventListener.call(this, type, wrapped, options);
    };

    // ------------------------------------------------------------------
    // UI Panel
    // ------------------------------------------------------------------
    function createPanel() {
        const css = `
            .forge-diagnostics-panel {
                position: fixed;
                bottom: 16px;
                right: 16px;
                width: 380px;
                max-height: 70vh;
                background: #0b0f19;
                border: 1px solid #4b5563;
                border-radius: 12px;
                color: #e0e0e0;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                font-size: 12px;
                z-index: 10000;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            }
            .forge-diagnostics-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px;
                background: #111827;
                border-bottom: 1px solid #374151;
                cursor: pointer;
                user-select: none;
            }
            .forge-diagnostics-header h3 {
                margin: 0;
                font-size: 13px;
                font-weight: 600;
            }
            .forge-diagnostics-badges {
                display: flex;
                gap: 6px;
            }
            .forge-diagnostics-badge {
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 10px;
                font-weight: 700;
                background: #374151;
            }
            .forge-diagnostics-badge.ok { background: #166534; color: #dcfce7; }
            .forge-diagnostics-badge.warn { background: #854d0e; color: #fef9c3; }
            .forge-diagnostics-badge.bad { background: #991b1b; color: #fee2e2; }
            .forge-diagnostics-body {
                padding: 12px 14px;
                overflow-y: auto;
                flex: 1;
                display: none;
            }
            .forge-diagnostics-panel.open .forge-diagnostics-body { display: block; }
            .forge-diagnostics-section {
                margin-bottom: 14px;
            }
            .forge-diagnostics-section h4 {
                margin: 0 0 6px;
                font-size: 11px;
                text-transform: uppercase;
                color: #9ca3af;
                letter-spacing: 0.05em;
            }
            .forge-diagnostics-bar {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 4px;
            }
            .forge-diagnostics-bar-label {
                width: 120px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .forge-diagnostics-bar-track {
                flex: 1;
                height: 8px;
                background: #374151;
                border-radius: 4px;
                overflow: hidden;
            }
            .forge-diagnostics-bar-fill {
                height: 100%;
                border-radius: 4px;
                background: #3b82f6;
            }
            .forge-diagnostics-bar-fill.slow { background: #ef4444; }
            .forge-diagnostics-bar-fill.medium { background: #f59e0b; }
            .forge-diagnostics-bar-value {
                width: 50px;
                text-align: right;
                font-variant-numeric: tabular-nums;
            }
            .forge-diagnostics-error {
                padding: 6px 8px;
                background: #1f2937;
                border-left: 3px solid #ef4444;
                border-radius: 0 4px 4px 0;
                margin-bottom: 6px;
                font-size: 11px;
                word-break: break-word;
            }
            .forge-diagnostics-btn {
                display: block;
                width: 100%;
                padding: 8px;
                background: #2563eb;
                color: #fff;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
                font-size: 12px;
                margin-top: 8px;
            }
            .forge-diagnostics-btn:hover { background: #1d4ed8; }
            .forge-diagnostics-empty {
                color: #6b7280;
                font-style: italic;
                text-align: center;
                padding: 8px 0;
            }
        `;

        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);

        panelEl = document.createElement("div");
        panelEl.className = "forge-diagnostics-panel";
        panelEl.innerHTML = `
            <div class="forge-diagnostics-header" id="fd-toggle">
                <h3>🔍 Forge Diagnostics</h3>
                <div class="forge-diagnostics-badges">
                    <span class="forge-diagnostics-badge" id="fd-badge-inp">INP —</span>
                    <span class="forge-diagnostics-badge" id="fd-badge-cls">CLS —</span>
                    <span class="forge-diagnostics-badge" id="fd-badge-err">0 err</span>
                </div>
            </div>
            <div class="forge-diagnostics-body">
                <div class="forge-diagnostics-section">
                    <h4>Startup Time</h4>
                    <div id="fd-startup">No data yet</div>
                </div>
                <div class="forge-diagnostics-section">
                    <h4>Slow Event Handlers</h4>
                    <div id="fd-handlers">No data yet</div>
                </div>
                <div class="forge-diagnostics-section">
                    <h4>Recent Errors</h4>
                    <div id="fd-errors">No data yet</div>
                </div>
                <div class="forge-diagnostics-section">
                    <h4>Memory (Chrome)</h4>
                    <div id="fd-memory">No data yet</div>
                </div>
                <button class="forge-diagnostics-btn" id="fd-export">📥 Export JSON Report</button>
            </div>
        `;
        document.body.appendChild(panelEl);

        document.getElementById("fd-toggle").addEventListener("click", () => {
            panelVisible = !panelVisible;
            panelEl.classList.toggle("open", panelVisible);
            render();
        });

        document.getElementById("fd-export").addEventListener("click", exportReport);
    }

    // ------------------------------------------------------------------
    // Render helpers
    // ------------------------------------------------------------------
    function render() {
        if (!panelVisible) return;
        renderStartup();
        renderHandlers();
        renderErrors();
        renderMemory();
    }

    function renderStartup() {
        const el = document.getElementById("fd-startup");
        if (!metrics.startup.length) {
            el.innerHTML = '<div class="forge-diagnostics-empty">Waiting for extensions to finish loading...</div>';
            return;
        }
        const max = Math.max(...metrics.startup.map((m) => m.duration), 1);
        el.innerHTML = metrics.startup
            .map((m) => {
                const pct = (m.duration / max) * 100;
                const cls = m.duration > 1000 ? "slow" : m.duration > 200 ? "medium" : "";
                return `<div class="forge-diagnostics-bar">
                    <div class="forge-diagnostics-bar-label" title="${m.name}">${m.name}</div>
                    <div class="forge-diagnostics-bar-track"><div class="forge-diagnostics-bar-fill ${cls}" style="width:${pct}%"></div></div>
                    <div class="forge-diagnostics-bar-value">${fmtMs(m.duration)}</div>
                </div>`;
            })
            .join("");
    }

    function renderHandlers() {
        const el = document.getElementById("fd-handlers");
        const list = metrics.handlers.slice(-10).reverse();
        if (!list.length) {
            el.innerHTML = '<div class="forge-diagnostics-empty">No slow handlers detected</div>';
            return;
        }
        el.innerHTML = list
            .map((h) => {
                return `<div class="forge-diagnostics-bar">
                    <div class="forge-diagnostics-bar-label" title="${h.fnName}">${h.event} › ${h.target}</div>
                    <div class="forge-diagnostics-bar-track"><div class="forge-diagnostics-bar-fill slow" style="width:100%"></div></div>
                    <div class="forge-diagnostics-bar-value">${fmtMs(h.duration)}</div>
                </div>`;
            })
            .join("");
    }

    function renderErrors() {
        const el = document.getElementById("fd-errors");
        const list = metrics.errors.slice(-5).reverse();
        if (!list.length) {
            el.innerHTML = '<div class="forge-diagnostics-empty">No errors yet</div>';
            return;
        }
        el.innerHTML = list
            .map((e) => `<div class="forge-diagnostics-error"><strong>${e.type}:</strong> ${e.message.substring(0, 200)}</div>`)
            .join("");
    }

    function renderMemory() {
        const el = document.getElementById("fd-memory");
        if (!metrics.memory.length) {
            el.innerHTML = '<div class="forge-diagnostics-empty">Memory API not available</div>';
            return;
        }
        const last = metrics.memory[metrics.memory.length - 1];
        const usedMB = (last.used / 1048576).toFixed(1);
        const totalMB = (last.total / 1048576).toFixed(1);
        el.innerHTML = `<div>Used: <strong>${usedMB} MB</strong> / Total: ${totalMB} MB</div>`;
    }

    // ------------------------------------------------------------------
    // Badge updaters (lightweight, run often)
    // ------------------------------------------------------------------
    function updateInpBadge() {
        const badge = document.getElementById("fd-badge-inp");
        if (!badge) return;
        const last = metrics.inp[metrics.inp.length - 1];
        if (!last) { badge.textContent = "INP —"; badge.className = "forge-diagnostics-badge"; return; }
        const v = last.value;
        badge.textContent = `INP ${fmtMs(v)}`;
        badge.className = "forge-diagnostics-badge " + (v < 200 ? "ok" : v < 500 ? "warn" : "bad");
    }

    function updateClsBadge() {
        const badge = document.getElementById("fd-badge-cls");
        if (!badge) return;
        badge.textContent = `CLS ${metrics.cls.toFixed(3)}`;
        badge.className = "forge-diagnostics-badge " + (metrics.cls < 0.1 ? "ok" : metrics.cls < 0.25 ? "warn" : "bad");
    }

    function updateLcpBadge() {
        // LCP is not shown in the mini badge, only in full panel if needed
    }

    function updateStartupBadge() {
        if (panelVisible) renderStartup();
    }

    function updateHandlerBadge() {
        if (panelVisible) renderHandlers();
        updateInpBadge();
    }

    function updateMemoryBadge() {
        if (panelVisible) renderMemory();
    }

    function updateErrorBadge() {
        const badge = document.getElementById("fd-badge-err");
        if (!badge) return;
        const count = metrics.errors.length;
        badge.textContent = `${count} err`;
        badge.className = "forge-diagnostics-badge " + (count === 0 ? "ok" : "bad");
        if (panelVisible) renderErrors();
    }

    // Wire error badge updates
    const origConsoleError = console.error;
    console.error = function (...args) {
        updateErrorBadge();
        origConsoleError.apply(console, args);
    };

    // ------------------------------------------------------------------
    // Export
    // ------------------------------------------------------------------
    function exportReport() {
        const report = {
            generatedAt: new Date().toISOString(),
            url: location.href,
            userAgent: navigator.userAgent,
            metrics: {
                startup: metrics.startup,
                inp: metrics.inp,
                cls: metrics.cls,
                lcp: metrics.lcp,
                memory: metrics.memory,
                errors: metrics.errors,
                handlers: metrics.handlers,
            },
        };
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `forge-diagnostics-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    function init() {
        createPanel();
        startMemoryPolling();
        console.log("[Forge Diagnostics] Profiler active. Click the 🔍 pill to open the panel.");
    }

    // Wait for Gradio root to be ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
