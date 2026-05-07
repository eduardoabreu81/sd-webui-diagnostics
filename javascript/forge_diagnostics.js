/**
 * SD-WebUI Diagnostics — Lightweight frontend profiler for SD WebUI.
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
        domNodes: [],         // {name, count, timestamp}
        network: [],          // {url, method, duration, status, timestamp}
        longTasks: [],        // {duration, timestamp}
        fps: [],              // {fps, dropped, timestamp}
        resources: [],        // {name, type, duration, transferSize, timestamp}
        gradioCalls: [],      // {url, method, duration, status, timestamp}
        extensionStatus: [],   // {name, loaded, errors, warnings, healthy}
    };

    let panelVisible = false;
    let panelEl = null;
    let memoryInterval = null;
    let domNodesInterval = null;
    let inactivityTimeout = null;
    let fpsRafId = null;

    // ------------------------------------------------------------------
    // Utils
    // ------------------------------------------------------------------
    const now = () => performance.now();
    const fmtMs = (n) => (n < 1000 ? `${n.toFixed(0)} ms` : `${(n / 1000).toFixed(2)} s`);

    function getConfig() {
        return window.SD_WEBUI_DIAGNOSTICS_CONFIG || {};
    }

    function applyConfig() {
        const CFG = getConfig();
        const badges = {
            "fd-badge-inp": "show_inp",
            "fd-badge-cls": "show_cls",
            "fd-badge-dom": "show_dom",
            "fd-badge-net": "show_net",
            "fd-badge-lt": "show_lt",
            "fd-badge-fps": "show_fps",
            "fd-badge-res": "show_res",
            "fd-badge-gradio": "show_gradio",
            "fd-badge-err": "show_err",
            "fd-badge-ext": "show_extension_health",
        };
        for (const [id, key] of Object.entries(badges)) {
            const el = document.getElementById(id);
            if (el) el.style.display = CFG[key] === false ? "none" : "";
        }
        const sections = {
            "fd-startup": "show_startup",
            "fd-handlers": "show_handlers",
            "fd-errors": "show_errors",
            "fd-memory": "show_memory",
            "fd-domnodes": "show_domnodes",
            "fd-network": "show_network",
            "fd-longtasks": "show_longtasks",
            "fd-fps": "show_fps_tab",
            "fd-resources": "show_resources",
            "fd-gradio": "show_gradio_tab",
            "fd-extension-health": "show_extension_health",
        };
        for (const [id, key] of Object.entries(sections)) {
            const el = document.getElementById(id);
            if (el) {
                const section = el.closest(".sd-webui-diagnostics-section");
                if (section) section.style.display = CFG[key] === false ? "none" : "";
            }
        }
    }

    // ------------------------------------------------------------------
    // Console interceptor
    // ------------------------------------------------------------------
    const origError = console.error;
    const origWarn = console.warn;

    console.error = function (...args) {
        metrics.errors.push({ type: "error", message: args.join(" "), stack: new Error().stack, timestamp: now() });
        updateErrorBadge();
        origError.apply(console, args);
    };

    console.warn = function (...args) {
        metrics.errors.push({ type: "warn", message: args.join(" "), stack: new Error().stack, timestamp: now() });
        updateErrorBadge();
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
                if (entry.entryType === "longtask") {
                    metrics.longTasks.push({ duration: entry.duration, timestamp: now() });
                    updateLongTaskBadge();
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
        // Long tasks (main thread blocks)
        if ("PerformanceLongTaskTiming" in window) {
            obs.observe({ type: "longtask", buffered: true });
        }
        // Resource loading
        try {
            const resObs = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.duration > 50) {
                        metrics.resources.push({
                            name: entry.name.substring(0, 200),
                            type: entry.initiatorType,
                            duration: entry.duration,
                            transferSize: entry.transferSize,
                            timestamp: now(),
                        });
                        if (metrics.resources.length > 200) metrics.resources.shift();
                        updateResourceBadge();
                    }
                }
            });
            resObs.observe({ type: "resource", buffered: true });
        } catch (e) { /* ignore */ }
    } catch (e) {
        console.error("[SD-WebUI Diagnostics] PerformanceObserver init failed:", e);
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
    // DOM nodes by extension
    // ------------------------------------------------------------------
    function detectExtensions() {
        const scripts = Array.from(document.querySelectorAll('script[src*="/extensions/"]'));
        const exts = new Set();
        scripts.forEach((s) => {
            const m = s.src.match(/\/extensions\/([^/]+)/);
            if (m) exts.add(m[1]);
        });
        return Array.from(exts);
    }

    function countDomNodesByExtension() {
        const extensions = detectExtensions();
        if (!extensions.length) return [];

        const extMap = new Map();
        extensions.forEach((e) => extMap.set(e.toLowerCase(), { name: e, count: 0 }));

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
            const id = (node.id || "").toLowerCase();
            const cls = (node.className || "").toLowerCase();
            for (const [lowName, data] of extMap) {
                if (id.includes(lowName) || cls.includes(lowName)) {
                    data.count++;
                }
            }
        }

        const result = [];
        for (const data of extMap.values()) {
            result.push({ name: data.name, count: data.count });
        }
        return result.sort((a, b) => b.count - a.count);
    }

    function updateDomNodes() {
        const counts = countDomNodesByExtension();
        metrics.domNodes = counts.map((c) => ({ ...c, timestamp: now() }));
        if (panelVisible) renderDomNodes();
        updateDomNodesBadge();
    }

    function startDomNodesObserver() {
        const extensions = detectExtensions();
        const extMap = new Map();
        extensions.forEach((e) => extMap.set(e.toLowerCase(), { name: e, count: 0 }));

        const initial = countDomNodesByExtension();
        initial.forEach((item) => {
            extMap.set(item.name.toLowerCase(), { name: item.name, count: item.count });
        });
        metrics.domNodes = initial.map((c) => ({ ...c, timestamp: now() }));
        updateDomNodesBadge();

        const observer = new MutationObserver((mutations) => {
            let changed = false;
            for (const mut of mutations) {
                for (const node of mut.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const id = (node.id || "").toLowerCase();
                        const cls = (node.className || "").toLowerCase();
                        for (const [lowName, data] of extMap) {
                            if (id.includes(lowName) || cls.includes(lowName)) {
                                data.count++;
                                changed = true;
                            }
                        }
                        const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
                        let child;
                        while ((child = walker.nextNode())) {
                            const cid = (child.id || "").toLowerCase();
                            const ccls = (child.className || "").toLowerCase();
                            for (const [lowName, data] of extMap) {
                                if (cid.includes(lowName) || ccls.includes(lowName)) {
                                    data.count++;
                                    changed = true;
                                }
                            }
                        }
                    }
                }
            }
            if (changed) {
                metrics.domNodes = Array.from(extMap.values())
                    .map((d) => ({ name: d.name, count: d.count, timestamp: now() }))
                    .sort((a, b) => b.count - a.count);
                if (panelVisible) renderDomNodes();
                updateDomNodesBadge();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        // Full re-scan every 30s to correct drift
        domNodesInterval = setInterval(() => {
            const counts = countDomNodesByExtension();
            counts.forEach((item) => {
                extMap.set(item.name.toLowerCase(), { name: item.name, count: item.count });
            });
            metrics.domNodes = counts.map((c) => ({ ...c, timestamp: now() }));
            if (panelVisible) renderDomNodes();
            updateDomNodesBadge();
        }, 30000);
    }

    // ------------------------------------------------------------------
    // FPS meter
    // ------------------------------------------------------------------
    function startFpsMeter() {
        let frames = 0;
        let dropped = 0;
        let lastTime = now();
        let lastFrameTime = now();
        const expectedInterval = 1000 / 60; // ~16.67ms per frame at 60Hz

        function tick(currentTime) {
            frames++;
            const frameDelta = currentTime - lastFrameTime;
            lastFrameTime = currentTime;

            // Real drop detection: if a frame took >1.5x the expected interval
            if (frameDelta > expectedInterval * 1.5) {
                dropped += Math.max(1, Math.round(frameDelta / expectedInterval) - 1);
            }

            const time = now();
            if (time >= lastTime + 1000) {
                const elapsed = (time - lastTime) / 1000;
                const fps = Math.round(frames / elapsed);
                metrics.fps.push({ fps, dropped, timestamp: time });
                if (metrics.fps.length > 60) metrics.fps.shift();
                updateFpsBadge();
                if (panelVisible) renderFps();
                frames = 0;
                dropped = 0;
                lastTime = time;
            }
            fpsRafId = requestAnimationFrame(tick);
        }
        fpsRafId = requestAnimationFrame(tick);
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
    const origRemoveEventListener = EventTarget.prototype.removeEventListener;
    const listenerMap = new WeakMap();

    EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (!listener || typeof listener !== "function") {
            return origAddEventListener.call(this, type, listener, options);
        }
        let wrapped = listenerMap.get(listener);
        if (!wrapped) {
            wrapped = function (event) {
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
            listenerMap.set(listener, wrapped);
        }
        return origAddEventListener.call(this, type, wrapped, options);
    };

    EventTarget.prototype.removeEventListener = function (type, listener, options) {
        const wrapped = listenerMap.get(listener);
        return origRemoveEventListener.call(this, type, wrapped || listener, options);
    };

    // ------------------------------------------------------------------
    // Network interceptor
    // ------------------------------------------------------------------
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
        const start = now();
        const req = args[0];
        const url = typeof req === "string" ? req : req?.url || "";
        const method = args[1]?.method || "GET";
        const isGradio = url.includes("/run/") || url.includes("/call") || url.includes("/queue/") || url.includes("/predict") || url.includes("/gradio") || url.includes("/api/predict") || url.includes("/queue/join") || url.includes("/internal/progress") || url.includes("/internal/ping");
        try {
            const res = await origFetch.apply(this, args);
            const duration = now() - start;
            metrics.network.push({ url: url.substring(0, 200), method, duration, status: res.status, timestamp: now() });
            if (isGradio) {
                metrics.gradioCalls.push({ url: url.substring(0, 200), method, duration, status: res.status, timestamp: now() });
                updateGradioBadge();
            }
            updateNetworkBadge();
            return res;
        } catch (e) {
            const duration = now() - start;
            metrics.network.push({ url: url.substring(0, 200), method, duration, status: 0, timestamp: now() });
            if (isGradio) {
                metrics.gradioCalls.push({ url: url.substring(0, 200), method, duration, status: 0, timestamp: now() });
                updateGradioBadge();
            }
            updateNetworkBadge();
            throw e;
        }
    };

    const origXHROpen = XMLHttpRequest.prototype.open;
    const origXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._fdMethod = method;
        this._fdUrl = url;
        return origXHROpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        const start = now();
        const url = (this._fdUrl || "");
        const isGradio = url.includes("/run/") || url.includes("/call") || url.includes("/queue/") || url.includes("/predict") || url.includes("/gradio") || url.includes("/api/predict") || url.includes("/queue/join") || url.includes("/internal/progress") || url.includes("/internal/ping");
        const onLoadEnd = () => {
            const duration = now() - start;
            metrics.network.push({ url: url.substring(0, 200), method: this._fdMethod || "GET", duration, status: this.status, timestamp: now() });
            if (isGradio) {
                metrics.gradioCalls.push({ url: url.substring(0, 200), method: this._fdMethod || "GET", duration, status: this.status, timestamp: now() });
                updateGradioBadge();
            }
            updateNetworkBadge();
        };
        this.addEventListener("loadend", onLoadEnd, { once: true });
        return origXHRSend.apply(this, args);
    };

    // ------------------------------------------------------------------
    // UI Panel
    // ------------------------------------------------------------------
    function createPanel() {
        const css = `
            .sd-webui-diagnostics-panel {
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
            .sd-webui-diagnostics-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px;
                background: #111827;
                border-bottom: 1px solid #374151;
                cursor: pointer;
                user-select: none;
            }
            .sd-webui-diagnostics-header h3 {
                margin: 0;
                font-size: 13px;
                font-weight: 600;
            }
            .sd-webui-diagnostics-badges {
                display: flex;
                gap: 6px;
            }
            .sd-webui-diagnostics-badge {
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 10px;
                font-weight: 700;
                background: #374151;
            }
            .sd-webui-diagnostics-badge.ok { background: #166534; color: #dcfce7; }
            .sd-webui-diagnostics-badge.warn { background: #854d0e; color: #fef9c3; }
            .sd-webui-diagnostics-badge.bad { background: #991b1b; color: #fee2e2; }
            .sd-webui-diagnostics-body {
                padding: 12px 14px;
                overflow-y: auto;
                flex: 1;
                display: none;
            }
            .sd-webui-diagnostics-panel.open .sd-webui-diagnostics-body { display: block; }
            .sd-webui-diagnostics-section {
                margin-bottom: 14px;
            }
            .sd-webui-diagnostics-section h4 {
                margin: 0 0 6px;
                font-size: 11px;
                text-transform: uppercase;
                color: #9ca3af;
                letter-spacing: 0.05em;
            }
            .sd-webui-diagnostics-bar {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 4px;
            }
            .sd-webui-diagnostics-bar-label {
                width: 120px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .sd-webui-diagnostics-bar-track {
                flex: 1;
                height: 8px;
                background: #374151;
                border-radius: 4px;
                overflow: hidden;
            }
            .sd-webui-diagnostics-bar-fill {
                height: 100%;
                border-radius: 4px;
                background: #3b82f6;
            }
            .sd-webui-diagnostics-bar-fill.slow { background: #ef4444; }
            .sd-webui-diagnostics-bar-fill.medium { background: #f59e0b; }
            .sd-webui-diagnostics-bar-value {
                width: 50px;
                text-align: right;
                font-variant-numeric: tabular-nums;
            }
            .sd-webui-diagnostics-error {
                padding: 6px 8px;
                background: #1f2937;
                border-left: 3px solid #ef4444;
                border-radius: 0 4px 4px 0;
                margin-bottom: 6px;
                font-size: 11px;
                word-break: break-word;
            }
            .sd-webui-diagnostics-btn {
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
            .sd-webui-diagnostics-btn:hover { background: #1d4ed8; }
            .sd-webui-diagnostics-empty {
                color: #6b7280;
                font-style: italic;
                text-align: center;
                padding: 8px 0;
            }
            .sd-webui-diagnostics-tabs {
                display: flex;
                gap: 2px;
                padding: 8px 14px 0;
                border-bottom: 1px solid #374151;
                overflow-x: auto;
            }
            .sd-webui-diagnostics-tab {
                padding: 5px 10px;
                border-radius: 4px 4px 0 0;
                cursor: pointer;
                font-size: 11px;
                font-weight: 600;
                color: #9ca3af;
                background: transparent;
                border: none;
                white-space: nowrap;
            }
            .sd-webui-diagnostics-tab:hover { color: #e0e0e0; }
            .sd-webui-diagnostics-tab.active {
                color: #e0e0e0;
                background: #1f2937;
                border-bottom: 2px solid #3b82f6;
            }
            .sd-webui-diagnostics-tab-content {
                display: none;
                padding: 12px 14px;
            }
            .sd-webui-diagnostics-tab-content.active {
                display: block;
            }
        `;

        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);

        panelEl = document.createElement("div");
        panelEl.className = "sd-webui-diagnostics-panel";
        panelEl.innerHTML = `
            <div class="sd-webui-diagnostics-header" id="fd-toggle">
                <h3>🔍 SD-WebUI Diagnostics</h3>
                <div class="sd-webui-diagnostics-badges">
                    <span class="sd-webui-diagnostics-badge" id="fd-badge-inp">INP —</span>
                    <span class="sd-webui-diagnostics-badge" id="fd-badge-cls">CLS —</span>
                    <span class="sd-webui-diagnostics-badge" id="fd-badge-dom">—</span>
                    <span class="sd-webui-diagnostics-badge" id="fd-badge-net">—</span>
                    <span class="sd-webui-diagnostics-badge" id="fd-badge-lt">—</span>
                    <span class="sd-webui-diagnostics-badge" id="fd-badge-fps">—</span>
                    <span class="sd-webui-diagnostics-badge" id="fd-badge-res">—</span>
                    <span class="sd-webui-diagnostics-badge" id="fd-badge-gradio">—</span>
                    <span class="sd-webui-diagnostics-badge" id="fd-badge-err">0 err</span>
                    <span class="sd-webui-diagnostics-badge" id="fd-badge-ext">—</span>
                </div>
            </div>
            <div class="sd-webui-diagnostics-body">
                <div class="sd-webui-diagnostics-tabs">
                    <button class="sd-webui-diagnostics-tab active" data-tab="overview">Overview</button>
                    <button class="sd-webui-diagnostics-tab" data-tab="startup">Startup</button>
                    <button class="sd-webui-diagnostics-tab" data-tab="events">Events</button>
                    <button class="sd-webui-diagnostics-tab" data-tab="network">Network</button>
                    <button class="sd-webui-diagnostics-tab" data-tab="performance">Perf</button>
                    <button class="sd-webui-diagnostics-tab" data-tab="extensions">Extensions</button>
                </div>
                <div class="sd-webui-diagnostics-tab-content active" id="fd-tab-overview">
                    <div id="fd-overview">No data yet</div>
                </div>
                <div class="sd-webui-diagnostics-tab-content" id="fd-tab-startup">
                    <div class="sd-webui-diagnostics-section"><h4>Startup Time</h4><div id="fd-startup">No data yet</div></div>
                </div>
                <div class="sd-webui-diagnostics-tab-content" id="fd-tab-events">
                    <div class="sd-webui-diagnostics-section"><h4>Slow Event Handlers</h4><div id="fd-handlers">No data yet</div></div>
                    <div class="sd-webui-diagnostics-section"><h4>Recent Errors</h4><div id="fd-errors">No data yet</div></div>
                    <div class="sd-webui-diagnostics-section"><h4>Long Tasks</h4><div id="fd-longtasks">No data yet</div></div>
                </div>
                <div class="sd-webui-diagnostics-tab-content" id="fd-tab-network">
                    <div class="sd-webui-diagnostics-section"><h4>Network Calls</h4><div id="fd-network">No data yet</div></div>
                    <div class="sd-webui-diagnostics-section"><h4>Gradio Calls</h4><div id="fd-gradio">No data yet</div></div>
                    <div class="sd-webui-diagnostics-section"><h4>Resource Loading</h4><div id="fd-resources">No data yet</div></div>
                </div>
                <div class="sd-webui-diagnostics-tab-content" id="fd-tab-performance">
                    <div class="sd-webui-diagnostics-section"><h4>Memory (Chrome)</h4><div id="fd-memory">No data yet</div></div>
                    <div class="sd-webui-diagnostics-section"><h4>FPS</h4><div id="fd-fps">No data yet</div></div>
                    <div class="sd-webui-diagnostics-section"><h4>DOM Nodes by Extension</h4><div id="fd-domnodes">No data yet</div></div>
                </div>
                <div class="sd-webui-diagnostics-tab-content" id="fd-tab-extensions">
                    <div class="sd-webui-diagnostics-section"><h4>Extension Health</h4><div id="fd-extension-health">No data yet</div></div>
                </div>
                <button class="sd-webui-diagnostics-btn" id="fd-export">📥 Export JSON Report</button>
                <button class="sd-webui-diagnostics-btn" id="fd-clear" style="background:#374151;margin-top:6px;">🔄 Clear Metrics</button>
            </div>
        `;
        document.body.appendChild(panelEl);

        document.getElementById("fd-toggle").addEventListener("click", () => {
            panelVisible = !panelVisible;
            panelEl.classList.toggle("open", panelVisible);
            render();
        });

        document.getElementById("fd-export").addEventListener("click", exportReport);
        document.getElementById("fd-clear").addEventListener("click", clearMetrics);


        document.querySelectorAll(".sd-webui-diagnostics-tab").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                switchTab(btn.dataset.tab);
            });
        });

        // Auto-collapse after 30s of inactivity
        panelEl.addEventListener("mousemove", resetInactivityTimer);
        panelEl.addEventListener("click", resetInactivityTimer);
        resetInactivityTimer();
        applyConfig();
    }

    // ------------------------------------------------------------------
    // Render helpers
    // ------------------------------------------------------------------
    let activeTab = "overview";
    function switchTab(tabName) {
        activeTab = tabName;
        document.querySelectorAll(".sd-webui-diagnostics-tab").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.tab === tabName);
        });
        document.querySelectorAll(".sd-webui-diagnostics-tab-content").forEach((content) => {
            content.classList.toggle("active", content.id === "fd-tab-" + tabName);
        });
        render();
    }

    function render() {
        if (!panelVisible) return;
        renderOverview();
        renderStartup();
        renderHandlers();
        renderErrors();
        renderMemory();
        renderDomNodes();
        renderNetwork();
        renderLongTasks();
        renderFps();
        renderResources();
        renderGradioCalls();
        renderExtensionHealth();
    }

    function renderOverview() {
        const el = document.getElementById("fd-overview");
        const lastFps = metrics.fps[metrics.fps.length - 1];
        const lastMem = metrics.memory[metrics.memory.length - 1];
        const lastNet = metrics.network[metrics.network.length - 1];
        const brokenExts = metrics.extensionStatus.filter((s) => !s.healthy).length;
        el.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
                <div style="background:#1f2937;padding:8px;border-radius:6px;text-align:center;">
                    <div style="font-size:10px;color:#9ca3af;">FPS</div>
                    <div style="font-size:18px;font-weight:700;">${lastFps ? lastFps.fps : "—"}</div>
                </div>
                <div style="background:#1f2937;padding:8px;border-radius:6px;text-align:center;">
                    <div style="font-size:10px;color:#9ca3af;">Memory</div>
                    <div style="font-size:18px;font-weight:700;">${lastMem ? (lastMem.used / 1048576).toFixed(0) + " MB" : "—"}</div>
                </div>
                <div style="background:#1f2937;padding:8px;border-radius:6px;text-align:center;">
                    <div style="font-size:10px;color:#9ca3af;">Errors</div>
                    <div style="font-size:18px;font-weight:700;color:${metrics.errors.length ? "#ef4444" : "#dcfce7"};">${metrics.errors.length}</div>
                </div>
                <div style="background:#1f2937;padding:8px;border-radius:6px;text-align:center;">
                    <div style="font-size:10px;color:#9ca3af;">Extensions</div>
                    <div style="font-size:18px;font-weight:700;color:${brokenExts ? "#ef4444" : "#dcfce7"};">${brokenExts ? brokenExts + " ⚠" : metrics.extensionStatus.length}</div>
                </div>
            </div>
            <div style="font-size:11px;color:#9ca3af;text-align:center;">
                INP: ${metrics.inp.length ? fmtMs(metrics.inp[metrics.inp.length - 1].value) : "—"} &nbsp;|&nbsp;
                CLS: ${metrics.cls.toFixed(3)} &nbsp;|&nbsp;
                Network: ${lastNet ? fmtMs(lastNet.duration) : "—"}
            </div>
        `;
    }

    function renderStartup() {
        const el = document.getElementById("fd-startup");
        if (!metrics.startup.length) {
            el.innerHTML = '<div class="sd-webui-diagnostics-empty">Waiting for extensions to finish loading...</div>';
            return;
        }
        const max = Math.max(...metrics.startup.map((m) => m.duration), 1);
        el.innerHTML = metrics.startup
            .map((m) => {
                const pct = (m.duration / max) * 100;
                const cls = m.duration > 1000 ? "slow" : m.duration > 200 ? "medium" : "";
                return `<div class="sd-webui-diagnostics-bar">
                    <div class="sd-webui-diagnostics-bar-label" title="${m.name}">${m.name}</div>
                    <div class="sd-webui-diagnostics-bar-track"><div class="sd-webui-diagnostics-bar-fill ${cls}" style="width:${pct}%"></div></div>
                    <div class="sd-webui-diagnostics-bar-value">${fmtMs(m.duration)}</div>
                </div>`;
            })
            .join("");
    }

    function renderHandlers() {
        const el = document.getElementById("fd-handlers");
        const list = metrics.handlers.slice(-10).reverse();
        if (!list.length) {
            el.innerHTML = '<div class="sd-webui-diagnostics-empty">No slow handlers detected</div>';
            return;
        }
        el.innerHTML = list
            .map((h) => {
                return `<div class="sd-webui-diagnostics-bar">
                    <div class="sd-webui-diagnostics-bar-label" title="${h.fnName}">${h.event} › ${h.target}</div>
                    <div class="sd-webui-diagnostics-bar-track"><div class="sd-webui-diagnostics-bar-fill slow" style="width:100%"></div></div>
                    <div class="sd-webui-diagnostics-bar-value">${fmtMs(h.duration)}</div>
                </div>`;
            })
            .join("");
    }

    function renderErrors() {
        const el = document.getElementById("fd-errors");
        const list = metrics.errors.slice(-5).reverse();
        if (!list.length) {
            el.innerHTML = '<div class="sd-webui-diagnostics-empty">No errors yet</div>';
            return;
        }
        el.innerHTML = list
            .map((e) => `<div class="sd-webui-diagnostics-error"><strong>${e.type}:</strong> ${e.message.substring(0, 200)}</div>`)
            .join("");
    }

    function renderMemory() {
        const el = document.getElementById("fd-memory");
        if (!metrics.memory.length) {
            el.innerHTML = '<div class="sd-webui-diagnostics-empty">Memory API not available</div>';
            return;
        }
        const last = metrics.memory[metrics.memory.length - 1];
        const usedMB = (last.used / 1048576).toFixed(1);
        const totalMB = (last.total / 1048576).toFixed(1);
        el.innerHTML = `<div>Used: <strong>${usedMB} MB</strong> / Total: ${totalMB} MB</div>`;
    }

    function renderDomNodes() {
        const el = document.getElementById("fd-domnodes");
        if (!metrics.domNodes.length) {
            el.innerHTML = '<div class="sd-webui-diagnostics-empty">No extension nodes detected</div>';
            return;
        }
        let max = 1;
        for (let i = 0; i < metrics.domNodes.length; i++) {
            if (metrics.domNodes[i].count > max) max = metrics.domNodes[i].count;
        }
        el.innerHTML = metrics.domNodes
            .map((m) => {
                const pct = (m.count / max) * 100;
                return `<div class="sd-webui-diagnostics-bar">
                    <div class="sd-webui-diagnostics-bar-label" title="${m.name}">${m.name}</div>
                    <div class="sd-webui-diagnostics-bar-track"><div class="sd-webui-diagnostics-bar-fill" style="width:${pct}%"></div></div>
                    <div class="sd-webui-diagnostics-bar-value">${m.count}</div>
                </div>`;
            })
            .join("");
    }

    function renderNetwork() {
        const el = document.getElementById("fd-network");
        const list = metrics.network.slice(-10).reverse();
        if (!list.length) {
            el.innerHTML = '<div class="sd-webui-diagnostics-empty">No network calls captured</div>';
            return;
        }
        const max = Math.max(...list.map((m) => m.duration), 1);
        el.innerHTML = list
            .map((m) => {
                const pct = (m.duration / max) * 100;
                const cls = m.duration > 3000 ? "slow" : m.duration > 1000 ? "medium" : "";
                const label = (m.url || "").replace(location.origin, "");
                return `<div class="sd-webui-diagnostics-bar">
                    <div class="sd-webui-diagnostics-bar-label" title="${label}">${m.method} ${label.substring(0, 30)}</div>
                    <div class="sd-webui-diagnostics-bar-track"><div class="sd-webui-diagnostics-bar-fill ${cls}" style="width:${pct}%"></div></div>
                    <div class="sd-webui-diagnostics-bar-value">${fmtMs(m.duration)}</div>
                </div>`;
            })
            .join("");
    }

    function renderLongTasks() {
        const el = document.getElementById("fd-longtasks");
        const list = metrics.longTasks.slice(-10).reverse();
        if (!list.length) {
            el.innerHTML = '<div class="sd-webui-diagnostics-empty">No long tasks detected</div>';
            return;
        }
        el.innerHTML = list
            .map((t, i) => {
                return `<div class="sd-webui-diagnostics-bar">
                    <div class="sd-webui-diagnostics-bar-label">Task #${metrics.longTasks.length - i}</div>
                    <div class="sd-webui-diagnostics-bar-track"><div class="sd-webui-diagnostics-bar-fill slow" style="width:100%"></div></div>
                    <div class="sd-webui-diagnostics-bar-value">${fmtMs(t.duration)}</div>
                </div>`;
            })
            .join("");
    }

    function renderFps() {
        const el = document.getElementById("fd-fps");
        if (!metrics.fps.length) {
            el.innerHTML = '<div class="sd-webui-diagnostics-empty">Collecting FPS data...</div>';
            return;
        }
        const last = metrics.fps[metrics.fps.length - 1];
        const avg = metrics.fps.reduce((s, m) => s + m.fps, 0) / metrics.fps.length;
        const totalDropped = metrics.fps.reduce((s, m) => s + m.dropped, 0);
        el.innerHTML = `<div>Current: <strong>${last.fps} FPS</strong> &nbsp;|&nbsp; Avg: ${avg.toFixed(0)} &nbsp;|&nbsp; Drops: ${totalDropped}</div>`;
    }

    function renderResources() {
        const el = document.getElementById("fd-resources");
        const list = metrics.resources.slice(-10).reverse();
        if (!list.length) {
            el.innerHTML = '<div class="sd-webui-diagnostics-empty">No slow resources detected</div>';
            return;
        }
        const max = Math.max(...list.map((m) => m.duration), 1);
        el.innerHTML = list
            .map((m) => {
                const pct = (m.duration / max) * 100;
                const cls = m.duration > 3000 ? "slow" : m.duration > 1000 ? "medium" : "";
                const name = (m.name || "").replace(location.origin, "").substring(0, 35);
                return `<div class="sd-webui-diagnostics-bar">
                    <div class="sd-webui-diagnostics-bar-label" title="${m.name}">${m.type} ${name}</div>
                    <div class="sd-webui-diagnostics-bar-track"><div class="sd-webui-diagnostics-bar-fill ${cls}" style="width:${pct}%"></div></div>
                    <div class="sd-webui-diagnostics-bar-value">${fmtMs(m.duration)}</div>
                </div>`;
            })
            .join("");
    }

    function renderGradioCalls() {
        const el = document.getElementById("fd-gradio");
        const list = metrics.gradioCalls.slice(-10).reverse();
        if (!list.length) {
            el.innerHTML = '<div class="sd-webui-diagnostics-empty">No Gradio calls captured</div>';
            return;
        }
        const max = Math.max(...list.map((m) => m.duration), 1);
        el.innerHTML = list
            .map((m) => {
                const pct = (m.duration / max) * 100;
                const cls = m.duration > 5000 ? "slow" : m.duration > 2000 ? "medium" : "";
                const label = (m.url || "").replace(location.origin, "").substring(0, 30);
                return `<div class="sd-webui-diagnostics-bar">
                    <div class="sd-webui-diagnostics-bar-label" title="${m.url}">${m.method} ${label}</div>
                    <div class="sd-webui-diagnostics-bar-track"><div class="sd-webui-diagnostics-bar-fill ${cls}" style="width:${pct}%"></div></div>
                    <div class="sd-webui-diagnostics-bar-value">${fmtMs(m.duration)}</div>
                </div>`;
            })
            .join("");
    }

    function analyzeExtensionHealth() {
        const extensions = detectExtensions();
        const status = [];
        for (const ext of extensions) {
            const lowerName = ext.toLowerCase();
            let errorCount = 0;
            let warnCount = 0;
            for (const err of metrics.errors) {
                const stack = (err.stack || "").toLowerCase();
                const msg = (err.message || "").toLowerCase();
                if (stack.includes(lowerName) || msg.includes(lowerName)) {
                    if (err.type === "error" || err.type === "exception") {
                        errorCount++;
                    } else {
                        warnCount++;
                    }
                }
            }
            status.push({
                name: ext,
                loaded: true,
                errors: errorCount,
                warnings: warnCount,
                healthy: errorCount === 0 && warnCount === 0,
            });
        }
        metrics.extensionStatus = status;
        updateExtensionBadge();
        if (panelVisible) renderExtensionHealth();
    }

    function renderExtensionHealth() {
        const el = document.getElementById("fd-extension-health");
        if (!metrics.extensionStatus.length) {
            el.innerHTML = '<div class="sd-webui-diagnostics-empty">No extensions detected</div>';
            return;
        }
        el.innerHTML = metrics.extensionStatus
            .map((s) => {
                const icon = s.healthy ? "✅" : s.errors > 0 ? "❌" : "⚠️";
                const startup = metrics.startup.find((st) => st.name.toLowerCase().includes(s.name.toLowerCase()));
                const startupTime = startup ? fmtMs(startup.duration) : "—";
                const domCount = metrics.domNodes.find((d) => d.name === s.name)?.count || 0;
                const extErrors = metrics.errors.filter((e) => {
                    const txt = ((e.stack || "") + (e.message || "")).toLowerCase();
                    return txt.includes(s.name.toLowerCase());
                });
                const errorPreview = extErrors.length
                    ? `<div style="font-size:10px;color:#fca5a5;margin-top:4px;font-family:monospace;">${extErrors[0].message.substring(0, 100)}</div>`
                    : "";
                return `<div style="background:#1f2937;padding:8px;border-radius:6px;margin-bottom:6px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                        <div style="font-weight:600;font-size:12px;">${icon} ${s.name}</div>
                        <div style="display:flex;gap:6px;align-items:center;">
                            <div style="font-size:10px;color:#9ca3af;">${startupTime} · ${domCount} nodes · ${s.errors} err · ${s.warnings} warn</div>
                            <button class="sd-webui-diagnostics-btn" style="padding:3px 8px;font-size:10px;background:#374151;" title="Reloads the entire WebUI page to refresh this extension" onclick="if(confirm('Reload the entire WebUI page?'))location.reload()">🔄 Reload</button>
                        </div>
                    </div>
                    ${errorPreview}
                </div>`;
            })
            .join("");
    }

    // ------------------------------------------------------------------
    // Badge updaters (lightweight, run often)
    // ------------------------------------------------------------------
    function updateInpBadge() {
        const badge = document.getElementById("fd-badge-inp");
        if (!badge) return;
        const last = metrics.inp[metrics.inp.length - 1];
        if (!last) { badge.textContent = "INP —"; badge.className = "sd-webui-diagnostics-badge"; return; }
        const v = last.value;
        badge.textContent = `INP ${fmtMs(v)}`;
        badge.className = "sd-webui-diagnostics-badge " + (v < 200 ? "ok" : v < 500 ? "warn" : "bad");
    }

    function updateClsBadge() {
        const badge = document.getElementById("fd-badge-cls");
        if (!badge) return;
        badge.textContent = `CLS ${metrics.cls.toFixed(3)}`;
        badge.className = "sd-webui-diagnostics-badge " + (metrics.cls < 0.1 ? "ok" : metrics.cls < 0.25 ? "warn" : "bad");
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

    function updateDomNodesBadge() {
        const badge = document.getElementById("fd-badge-dom");
        if (!badge) return;
        const total = metrics.domNodes.reduce((sum, m) => sum + m.count, 0);
        badge.textContent = `${total} nodes`;
        badge.className = "sd-webui-diagnostics-badge" + (total > 5000 ? " warn" : "");
    }

    function updateNetworkBadge() {
        const badge = document.getElementById("fd-badge-net");
        if (!badge) return;
        const last = metrics.network[metrics.network.length - 1];
        badge.textContent = last ? `NET ${fmtMs(last.duration)}` : "NET —";
        badge.className = "sd-webui-diagnostics-badge " + (!last ? "" : last.duration < 1000 ? "ok" : last.duration < 3000 ? "warn" : "bad");
    }

    function updateLongTaskBadge() {
        const badge = document.getElementById("fd-badge-lt");
        if (!badge) return;
        const count = metrics.longTasks.length;
        badge.textContent = `${count} LT`;
        badge.className = "sd-webui-diagnostics-badge " + (count === 0 ? "ok" : "warn");
    }

    function updateFpsBadge() {
        const badge = document.getElementById("fd-badge-fps");
        if (!badge) return;
        const last = metrics.fps[metrics.fps.length - 1];
        badge.textContent = last ? `${last.fps} FPS` : "FPS —";
        badge.className = "sd-webui-diagnostics-badge " + (!last ? "" : last.fps >= 50 ? "ok" : last.fps >= 30 ? "warn" : "bad");
    }

    function updateResourceBadge() {
        const badge = document.getElementById("fd-badge-res");
        if (!badge) return;
        const count = metrics.resources.length;
        badge.textContent = `${count} res`;
        badge.className = "sd-webui-diagnostics-badge";
    }

    function updateGradioBadge() {
        const badge = document.getElementById("fd-badge-gradio");
        if (!badge) return;
        const last = metrics.gradioCalls[metrics.gradioCalls.length - 1];
        badge.textContent = last ? `GRD ${fmtMs(last.duration)}` : "GRD —";
        badge.className = "sd-webui-diagnostics-badge " + (!last ? "" : last.duration < 2000 ? "ok" : last.duration < 5000 ? "warn" : "bad");
    }

    function updateErrorBadge() {
        const badge = document.getElementById("fd-badge-err");
        if (!badge) return;
        const count = metrics.errors.length;
        badge.textContent = `${count} err`;
        badge.className = "sd-webui-diagnostics-badge " + (count === 0 ? "ok" : "bad");
        if (panelVisible) renderErrors();
        analyzeExtensionHealth();
    }

    function updateExtensionBadge() {
        const badge = document.getElementById("fd-badge-ext");
        if (!badge) return;
        const broken = metrics.extensionStatus.filter((s) => !s.healthy).length;
        badge.textContent = `${metrics.extensionStatus.length} ext`;
        badge.className = "sd-webui-diagnostics-badge " + (broken === 0 ? "ok" : "bad");
    }

    // ------------------------------------------------------------------
    // Auto-collapse after inactivity
    // ------------------------------------------------------------------
    function resetInactivityTimer() {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        if (panelVisible) {
            inactivityTimeout = setTimeout(() => {
                panelVisible = false;
                if (panelEl) panelEl.classList.remove("open");
            }, 30000);
        }
    }

    // ------------------------------------------------------------------
    // Clear / Refresh
    // ------------------------------------------------------------------
    function clearMetrics() {
        metrics.startup.length = 0;
        metrics.inp.length = 0;
        metrics.cls = 0;
        metrics.lcp = 0;
        metrics.memory.length = 0;
        metrics.errors.length = 0;
        metrics.handlers.length = 0;
        metrics.domNodes.length = 0;
        metrics.network.length = 0;
        metrics.longTasks.length = 0;
        metrics.fps.length = 0;
        metrics.resources.length = 0;
        metrics.gradioCalls.length = 0;
        metrics.extensionStatus.length = 0;
        updateInpBadge();
        updateClsBadge();
        updateErrorBadge();
        updateDomNodesBadge();
        updateNetworkBadge();
        updateLongTaskBadge();
        updateFpsBadge();
        updateResourceBadge();
        updateGradioBadge();
        updateExtensionBadge();
        if (panelVisible) render();
        console.log("[SD-WebUI Diagnostics] Metrics cleared.");
    }

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
                domNodes: metrics.domNodes,
                network: metrics.network,
                longTasks: metrics.longTasks,
                fps: metrics.fps,
                resources: metrics.resources,
                gradioCalls: metrics.gradioCalls,
                extensionStatus: metrics.extensionStatus,
            },
        };
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `sd-webui-diagnostics-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    function init() {
        createPanel();
        startMemoryPolling();
        startDomNodesObserver();
        startFpsMeter();
        analyzeExtensionHealth();
        console.log("[SD-WebUI Diagnostics] Profiler active. Click the 🔍 pill to open the panel.");
    }

    // Wait for Gradio root to be ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
