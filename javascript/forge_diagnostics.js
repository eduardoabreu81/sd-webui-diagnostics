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

    const VERSION = "v0.2.0";

    let panelState = 'bar';       // 'icon' | 'bar' | 'expanded'
    let prevMinimizedState = 'bar'; // last non-expanded state
    let panelEl = null;
    let memoryInterval = null;
    let lastDomScan = 0;
    let inactivityTimeout = null;
    let fpsRafId = null;
    let widgetDestroyed = false;

    // ------------------------------------------------------------------
    // Utils
    // ------------------------------------------------------------------
    const now = () => performance.now();
    const fmtMs = (n) => (n < 1000 ? `${n.toFixed(0)} ms` : `${(n / 1000).toFixed(2)} s`);
    const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
            "fd-badge-ckpt": "show_extension_health",
            "fd-badge-lora": "show_extension_health",
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
        const defaultState = CFG.default_state || 'bar';
        setPanelState(defaultState);
    }
    function setPanelState(newState) {
        if (!panelEl) return;
        if (panelState === 'expanded' && newState !== 'expanded') {
            prevMinimizedState = newState;
        }
        panelState = newState;
        panelEl.classList.remove('state-icon', 'state-bar', 'state-expanded');
        panelEl.classList.add(`state-${newState}`);
        updateIconView();
        render();
    }

    function updateIconView() {
        const iconView = document.getElementById("fd-icon-view");
        if (!iconView) return;
        const CFG = getConfig();
        const metric = CFG.icon_metric || "none";
        if (metric === "none") {
            iconView.textContent = '🔍';
        } else if (metric === "errors") {
            iconView.textContent = String(metrics.errors.length);
        } else if (metric === "inp") {
            const last = metrics.inp[metrics.inp.length - 1];
            iconView.textContent = last ? fmtMs(last.value) : '🔍';
        } else if (metric === "memory") {
            const last = metrics.memory[metrics.memory.length - 1];
            iconView.textContent = last ? String((last.used / 1048576).toFixed(0)) : '🔍';
        } else if (metric === "fps") {
            const last = metrics.fps[metrics.fps.length - 1];
            iconView.textContent = last ? String(last.fps) : '🔍';
        }
    }


    // ------------------------------------------------------------------
    // Console interceptor
    // ------------------------------------------------------------------
    const origError = console.error;
    const origWarn = console.warn;

    function _safeStringify(args) {
        try {
            return args.map(a => {
                if (a == null) return String(a);
                if (typeof a === 'object') {
                    try { return JSON.stringify(a); } catch { return '[Object]'; }
                }
                return String(a);
            }).join(' ');
        } catch {
            return '[Console message stringify failed]';
        }
    }

    console.error = function (...args) {
        const msg = _safeStringify(args);
        const last = metrics.errors[metrics.errors.length - 1];
        if (!last || last.message !== msg || (now() - last.timestamp) > 1000) {
            metrics.errors.push({ type: "error", message: msg, stack: new Error().stack, timestamp: now() });
            updateErrorBadge();
        }
        origError.apply(console, args);
    };

    console.warn = function (...args) {
        const msg = _safeStringify(args);
        const last = metrics.errors[metrics.errors.length - 1];
        if (!last || last.message !== msg || (now() - last.timestamp) > 1000) {
            metrics.errors.push({ type: "warn", message: msg, stack: new Error().stack, timestamp: now() });
            updateErrorBadge();
        }
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
    let backendExtensions = [];
    let backendStateLoaded = false;
    let modelCounts = { checkpoints: 0, loras: 0 };

    function destroyWidget() {
        if (widgetDestroyed) return;
        widgetDestroyed = true;
        if (panelEl && panelEl.parentNode) {
            panelEl.parentNode.removeChild(panelEl);
        }
        panelEl = null;
        if (memoryInterval) {
            clearInterval(memoryInterval);
            memoryInterval = null;
        }
        if (fpsRafId) {
            cancelAnimationFrame(fpsRafId);
            fpsRafId = null;
        }
        if (inactivityTimeout) {
            clearTimeout(inactivityTimeout);
            inactivityTimeout = null;
        }
        console.log("[SD-WebUI Diagnostics] Widget disabled via Settings — removed from page.");
    }

    async function loadBackendState() {
        try {
            const res = await fetch("/sd-webui-diagnostics/api/state");
            if (res.ok) {
                const data = await res.json();
                if (data.config && data.config.enabled === false) {
                    destroyWidget();
                    return;
                }
                backendExtensions = data.extensions || [];
                modelCounts = data.models || { checkpoints: 0, loras: 0 };
                backendStateLoaded = true;
                analyzeExtensionHealth();
                updateCheckpointBadge();
                updateLoraBadge();
                return;
            }
        } catch (e) {
            // Endpoint unavailable, try static fallback
        }
        const fallback = window.SD_WEBUI_DIAGNOSTICS_STATE;
        if (fallback) {
            if (fallback.extensions) {
                backendExtensions = fallback.extensions;
                backendStateLoaded = true;
                analyzeExtensionHealth();
            }
            if (fallback.models) {
                modelCounts = fallback.models;
                updateCheckpointBadge();
                updateLoraBadge();
            }
        }
    }

    function detectExtensions() {
        if (backendStateLoaded && backendExtensions.length) {
            return backendExtensions.map((e) => e.name);
        }
        // Fallback: heuristic from DOM script tags
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
            const cls = String(node.className || "").toLowerCase();
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

    function updateDomNodesBadge() {
        const badge = document.getElementById("fd-badge-dom");
        if (!badge) return;
        const total = document.querySelectorAll("*").length;
        badge.textContent = `${total} nodes`;
        badge.title = `${total} total DOM nodes`;
        badge.className = "sd-webui-diagnostics-badge" + (total > 5000 ? " warn" : "");
    }

    function startDomNodesObserver() {
        // Only do a full scan once on init, then keep badge cheap with querySelectorAll
        updateDomNodesBadge();
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
                if (panelState === 'expanded') renderFps();
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

    // Build a composite key so the same listener registered with different
    // types/options gets wrapped independently.  This prevents Svelte/Gradio
    // from losing event listeners when tabs or components re-bind.
    function _listenerKey(listener, type, options) {
        // Do NOT use JSON.stringify — options may contain cycles or
        // non-serialisable values (common in Gradio 4 / Svelte internals).
        let optStr;
        if (options == null) {
            optStr = '';
        } else if (typeof options === 'boolean') {
            optStr = options ? 'true' : 'false';
        } else if (typeof options === 'object') {
            // Only extract the well-known EventListenerOptions fields.
            // This is safe regardless of cycles or extra properties.
            const bits = [];
            if (options.capture) bits.push('capture');
            if (options.once) bits.push('once');
            if (options.passive) bits.push('passive');
            optStr = bits.join(',') || '{}';
        } else {
            optStr = String(options);
        }
        return `${type}::${optStr}`;
    }

    EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (!listener || typeof listener !== "function") {
            return origAddEventListener.call(this, type, listener, options);
        }
        let byType = listenerMap.get(listener);
        if (!byType) {
            byType = new Map();
            listenerMap.set(listener, byType);
        }
        const key = _listenerKey(listener, type, options);
        let wrapped = byType.get(key);
        if (!wrapped) {
            wrapped = function (event) {
                const start = now();
                try {
                    return listener.call(this, event);   // <-- preserve return value
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
            byType.set(key, wrapped);
        }
        return origAddEventListener.call(this, type, wrapped, options);
    };

    EventTarget.prototype.removeEventListener = function (type, listener, options) {
        const byType = listenerMap.get(listener);
        const key = byType ? _listenerKey(listener, type, options) : null;
        const wrapped = key ? byType.get(key) : null;
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
    function applyAnchor(anchor) {
        if (!panelEl) return;
        const margin = 16;
        panelEl.style.left = '';
        panelEl.style.top = '';
        panelEl.style.right = '';
        panelEl.style.bottom = '';
        if (anchor === 'top-left') {
            panelEl.style.top = margin + 'px';
            panelEl.style.left = margin + 'px';
        } else if (anchor === 'top-right') {
            panelEl.style.top = margin + 'px';
            panelEl.style.right = margin + 'px';
        } else if (anchor === 'bottom-left') {
            panelEl.style.bottom = margin + 'px';
            panelEl.style.left = margin + 'px';
        } else {
            panelEl.style.bottom = margin + 'px';
            panelEl.style.right = margin + 'px';
        }
    }

    function createPanel() {
        console.log("[SD-WebUI Diagnostics] createPanel() called");
        const css = `
            .sd-webui-diagnostics-panel {
                position: fixed;
                z-index: 10000;
                background: #0b0f19;
                border: 1px solid #4b5563;
                color: #e0e0e0;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                font-size: 12px;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                resize: none;
            }
            /* State: icon */
            .sd-webui-diagnostics-panel.state-icon {
                width: auto;
                height: 40px;
                min-width: 40px;
                border-radius: 20px;
                cursor: pointer;
            }
            .sd-webui-diagnostics-panel.state-icon .sd-webui-diagnostics-header {
                border-bottom: none;
                padding: 0;
                justify-content: center;
                position: relative;
                width: 100%;
                height: 100%;
            }
            .sd-webui-diagnostics-panel.state-icon .sd-webui-diagnostics-header h3,
            .sd-webui-diagnostics-panel.state-icon .sd-webui-diagnostics-badges,
            .sd-webui-diagnostics-panel.state-icon .fd-drag-handle,
            .sd-webui-diagnostics-panel.state-icon .fd-state-btn { display: none !important; }
            .sd-webui-diagnostics-panel.state-icon .sd-webui-diagnostics-icon-view {
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 14px;
                font-weight: 700;
                gap: 4px;
                position: absolute;
                inset: 0;
                margin: auto;
                width: 100%;
                height: 100%;
            }
            .sd-webui-diagnostics-panel.state-icon .sd-webui-diagnostics-body { display: none; }
            /* State: bar */
            .sd-webui-diagnostics-panel.state-bar {
                width: auto;
                min-width: unset;
                max-width: 90vw;
                border-radius: 12px;
            }
            .sd-webui-diagnostics-panel.state-bar .sd-webui-diagnostics-header {
                padding: 6px 10px;
                border-bottom: 1px solid #374151;
                justify-content: flex-start;
                gap: 8px;
            }
            .sd-webui-diagnostics-panel.state-bar .sd-webui-diagnostics-header h3 {
                display: block;
                font-size: 9px;
                line-height: 1.2;
                text-align: center;
                margin: 0 6px 0 0;
                flex-shrink: 0;
                width: max-content;
            }
            .sd-webui-diagnostics-panel.state-bar .sd-webui-diagnostics-badges {
                flex: 1;
                min-width: 0;
            }
            .sd-webui-diagnostics-panel.state-bar .sd-webui-diagnostics-badges {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 2px;
                max-width: 320px;
            }
            .sd-webui-diagnostics-panel.state-bar .sd-webui-diagnostics-badge {
                font-size: 8px !important;
                padding: 1px 2px !important;
                border-radius: 3px !important;
            }
            .sd-webui-diagnostics-panel.state-bar .sd-webui-diagnostics-icon-view { display: none; }
            .sd-webui-diagnostics-panel.state-bar .sd-webui-diagnostics-body { display: none; }
            /* State: expanded */
            .sd-webui-diagnostics-panel.state-expanded {
                width: 460px;
                min-width: 320px;
                max-width: 90vw;
                max-height: 70vh;
                border-radius: 12px;
                resize: horizontal;
            }
            .sd-webui-diagnostics-panel.state-expanded .sd-webui-diagnostics-body {
                display: block;
                max-height: 70vh;
                opacity: 1;
                padding: 12px 14px;
            }
            .sd-webui-diagnostics-panel.state-expanded .sd-webui-diagnostics-icon-view { display: none; }
            /* Drag handle & state buttons (shared bar/expanded) */
            .fd-drag-handle {
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                gap: 2px;
                width: 14px;
                height: 20px;
                cursor: grab;
                color: #6b7280;
                font-size: 10px;
                line-height: 2px;
                user-select: none;
                flex-shrink: 0;
            }
            .fd-drag-handle:active { cursor: grabbing; }
            .fd-state-btn {
                background: transparent;
                border: none;
                color: #9ca3af;
                font-size: 13px;
                cursor: pointer;
                padding: 0 2px;
                line-height: 1;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .fd-state-btn:hover { color: #e0e0e0; }
            .sd-webui-diagnostics-panel.state-expanded #fd-btn-expand { display: none; }
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
                font-size: 11px;
                font-weight: 600;
                line-height: 1.3;
                text-align: center;
            }
            .sd-webui-diagnostics-badges {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 4px;
                width: 100%;
                max-width: 360px;
            }
            .sd-webui-diagnostics-badge {
                padding: 2px 4px;
                border-radius: 4px;
                font-size: 10px;
                font-weight: 700;
                background: #374151;
                text-align: center;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                min-width: 0;
            }
            .sd-webui-diagnostics-badge.ok { background: #166534; color: #dcfce7; }
            .sd-webui-diagnostics-badge.warn { background: #854d0e; color: #fef9c3; }
            .sd-webui-diagnostics-badge.bad { background: #991b1b; color: #fee2e2; }
            .sd-webui-diagnostics-body {
                overflow-y: auto;
                flex: 1;
            }
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
            .sd-webui-diagnostics-footer {
                font-size: 10px;
                color: #6b7280;
                text-align: center;
                padding: 8px 14px;
                border-top: 1px solid #374151;
                margin-top: 4px;
            }
        `;

        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);

        panelEl = document.createElement("div");
        panelEl.className = "sd-webui-diagnostics-panel state-bar";
        panelEl.innerHTML = `
            <div class="sd-webui-diagnostics-header" id="fd-toggle">
                <!-- Icon-only view -->
                <div class="sd-webui-diagnostics-icon-view" id="fd-icon-view">🔍</div>
                <!-- Drag handle -->
                <div class="fd-drag-handle" id="fd-drag-handle" title="Drag to move">⋮<br>⋮<br>⋮</div>
                <!-- Title -->
                <h3>🔍 SD-WebUI<br>Diagnostics</h3>
                <!-- Badges -->
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
                    <span class="sd-webui-diagnostics-badge" id="fd-badge-ckpt">—</span>
                    <span class="sd-webui-diagnostics-badge" id="fd-badge-lora">—</span>
                </div>
                <!-- State controls -->
                <button class="fd-state-btn" id="fd-btn-expand" title="Expand">⤢</button>
                <button class="fd-state-btn" id="fd-btn-collapse" title="Collapse">−</button>
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
                <div class="sd-webui-diagnostics-footer">SD-WebUI Diagnostics ${VERSION}</div>
            </div>
        `;
        document.body.appendChild(panelEl);

        // Header click toggles between bar <-> expanded (icon is too small, goes to bar)
        document.getElementById("fd-toggle").addEventListener("click", (e) => {
            if (e.target.closest("button, [data-action], .fd-drag-handle")) return;
            if (panelState === 'icon') setPanelState('bar');
            else if (panelState === 'bar') setPanelState('expanded');
            else if (panelState === 'expanded') setPanelState(prevMinimizedState);
        });

        // Explicit state buttons
        document.getElementById("fd-btn-expand").addEventListener("click", (e) => {
            e.stopPropagation();
            setPanelState('expanded');
        });
        document.getElementById("fd-btn-collapse").addEventListener("click", (e) => {
            e.stopPropagation();
            if (panelState === 'expanded') setPanelState(prevMinimizedState);
            else if (panelState === 'bar') setPanelState('icon');
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
        panelEl.addEventListener("click", (e) => {
            resetInactivityTimer();
            // Event delegation for dynamically-rendered buttons/checkboxes
            const target = e.target.closest("[data-action]");
            if (!target) return;
            const action = target.dataset.action;
            if (action === "toggle-builtins") {
                toggleBuiltins();
            } else if (action === "reload-backend") {
                loadBackendState();
            } else if (action === "reload-page") {
                if (confirm("Reload the entire WebUI page?")) location.reload();
            } else if (action === "toggle-startup-errors") {
                const errEl = document.getElementById(target.dataset.targetId);
                const count = parseInt(target.dataset.count, 10);
                if (errEl) {
                    const isHidden = errEl.style.display === "none";
                    errEl.style.display = isHidden ? "block" : "none";
                    target.textContent = (isHidden ? "▼" : "▶") + " " + count + " startup error" + (count > 1 ? "s" : "");
                }
            }
        });
        panelEl.addEventListener("change", (e) => {
            const target = e.target.closest("[data-action]");
            if (!target) return;
            const action = target.dataset.action;
            if (action === "toggle-builtins") {
                toggleBuiltins();
            }
        });

        // Drag: widget follows mouse via transform, snaps on release
        let dragState = { active: false, startX: 0, startY: 0, origLeft: 0, origTop: 0 };
        const dragHandle = document.getElementById("fd-drag-handle");
        dragHandle.addEventListener("mousedown", (e) => {
            dragState.active = true;
            dragState.startX = e.clientX;
            dragState.startY = e.clientY;
            const rect = panelEl.getBoundingClientRect();
            dragState.origLeft = rect.left;
            dragState.origTop = rect.top;
            // Freeze layout and prepare for smooth transform-based drag
            panelEl.style.transition = 'none';
            panelEl.style.willChange = 'transform';
            panelEl.style.transform = 'translate3d(0,0,0)';
            dragHandle.style.cursor = 'grabbing';
        });
        document.addEventListener("mousemove", (e) => {
            if (!dragState.active || !panelEl) return;
            e.preventDefault();
            let dx = e.clientX - dragState.startX;
            let dy = e.clientY - dragState.startY;
            // Clamp so panel stays inside viewport
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const rect = panelEl.getBoundingClientRect();
            const minDx = -dragState.origLeft;
            const maxDx = vw - dragState.origLeft - rect.width;
            const minDy = -dragState.origTop;
            const maxDy = vh - dragState.origTop - rect.height;
            dx = Math.max(minDx, Math.min(dx, maxDx));
            dy = Math.max(minDy, Math.min(dy, maxDy));
            panelEl.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
        });
        document.addEventListener("mouseup", () => {
            if (!dragState.active || !panelEl) return;
            dragState.active = false;
            dragHandle.style.cursor = '';
            // Read final visual position
            const rect = panelEl.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            // Clear transform and switch back to anchored positioning
            panelEl.style.willChange = '';
            panelEl.style.transform = '';
            panelEl.style.transition = '';
            const anchor = (cy < vh / 2 ? 'top' : 'bottom') + '-' + (cx < vw / 2 ? 'left' : 'right');
            applyAnchor(anchor);
            localStorage.setItem('sd_diagnostics_anchor', anchor);
        });

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
        if (panelState !== 'expanded') return;
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
        if (!el) return;
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
        if (!el) return;
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
        if (!el) return;
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
        if (!el) return;
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
        if (!el) return;
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
        if (!el) return;
        // Scan on-demand only; throttle to once per 5s
        const t = now();
        if (t - lastDomScan > 5000) {
            lastDomScan = t;
            const counts = countDomNodesByExtension();
            metrics.domNodes = counts.map((c) => ({ ...c, timestamp: t }));
        }
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
                    <div class="sd-webui-diagnostics-bar-value">${m.count.toLocaleString()}</div>
                </div>`;
            })
            .join("");
    }

    function renderNetwork() {
        const el = document.getElementById("fd-network");
        if (!el) return;
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
        if (!el) return;
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
        if (!el) return;
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
        if (!el) return;
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
        if (!el) return;
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

    function _isBuiltin(ext) {
        if (ext.is_builtin !== undefined) return !!ext.is_builtin;
        const remote = ext.remote || "";
        const path = ext.path || "";
        return (
            !remote
            || remote === "built-in"
            || /builtin|built-in|extensions-builtin/i.test(path)
        );
    }

    function analyzeExtensionHealth() {
        let extensions;
        let useBackend = false;
        if (backendStateLoaded && backendExtensions.length) {
            extensions = backendExtensions;
            useBackend = true;
        } else {
            extensions = detectExtensions().map((name) => ({ name }));
        }
        const status = [];
        for (const ext of extensions) {
            const name = ext.name || ext;
            const lowerName = name.toLowerCase();
            let errorCount = 0;
            let warnCount = 0;
            for (const err of metrics.errors) {
                const stack = (err.stack || "").toLowerCase();
                const msg = String(err.message || "").toLowerCase();
                // Don't self-attribute generic console warnings captured by our interceptor
                if (name === "sd-webui-diagnostics" && !msg.includes("sd-webui-diagnostics")) {
                    continue;
                }
                if (stack.includes(lowerName) || msg.includes(lowerName)) {
                    if (err.type === "error" || err.type === "exception") {
                        errorCount++;
                    } else {
                        warnCount++;
                    }
                }
            }
            status.push({
                name: name,
                loaded: useBackend ? ext.enabled !== false : true,
                errors: errorCount,
                warnings: warnCount,
                healthy: errorCount === 0 && warnCount === 0,
                startupMs: useBackend ? ext.startup_ms : null,
                version: useBackend ? ext.version : null,
                remote: useBackend ? ext.remote : null,
                startupErrors: useBackend ? (ext.startup_errors || []) : [],
                is_builtin: _isBuiltin(ext),
            });
        }
        metrics.extensionStatus = status;
        updateExtensionBadge();
        if (panelState === 'expanded') renderExtensionHealth();
    }

    function _renderExtCard(s) {
        const icon = s.healthy ? "✅" : s.errors > 0 ? "❌" : "⚠️";
        const startupTime = s.startupMs ? fmtMs(s.startupMs) : "—";
        const domCount = metrics.domNodes.find((d) => d.name === s.name)?.count || 0;
        const versionTag = s.version ? `<span style="font-size:9px;color:#6b7280;margin-left:4px;">${s.version}</span>` : "";
        const extErrors = metrics.errors.filter((e) => {
            const msg = String(e.message || "").toLowerCase();
            const stack = (e.stack || "").toLowerCase();
            // Don't self-attribute generic console warnings
            if (s.name === "sd-webui-diagnostics" && !msg.includes("sd-webui-diagnostics")) {
                return false;
            }
            return msg.includes(s.name.toLowerCase()) || stack.includes(s.name.toLowerCase());
        });
        const errorPreview = extErrors.length
            ? `<div style="font-size:10px;color:#fca5a5;margin-top:4px;font-family:monospace;">${String(extErrors[0].message).substring(0, 100)}</div>`
            : "";
        const startupErrCount = s.startupErrors ? s.startupErrors.length : 0;
        let startupErrHtml = "";
        if (startupErrCount > 0) {
            const errId = "fd-se-" + s.name.replace(/[^a-z0-9]/gi, "_");
            const lines = s.startupErrors.map((e) => `• ${e.callback}: ${e.message}`).join("\n");
            startupErrHtml = `
                <div style="margin-top:6px;">
                    <button class="sd-webui-diagnostics-btn" style="padding:3px 8px;font-size:10px;background:#991b1b;" data-action="toggle-startup-errors" data-target-id="${errId}" data-count="${startupErrCount}">▶ ${startupErrCount} startup error${startupErrCount > 1 ? "s" : ""}</button>
                    <pre id="${errId}" style="display:none;font-size:9px;color:#fca5a5;background:#1f2937;padding:6px;border-radius:4px;margin-top:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;">${escapeHtml(lines)}</pre>
                </div>`;
        }
        return `<div style="background:#1f2937;padding:8px;border-radius:6px;margin-bottom:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <div style="font-weight:600;font-size:12px;">${icon} ${s.name}${versionTag}</div>
                <div style="display:flex;gap:6px;align-items:center;">
                    <div style="font-size:10px;color:#9ca3af;">${startupTime} · ${domCount} nodes · ${s.errors} err · ${s.warnings} warn</div>
                    <button class="sd-webui-diagnostics-btn" style="padding:3px 8px;font-size:10px;background:#374151;" title="Reloads the entire WebUI page to refresh this extension" data-action="reload-page">🔄 Reload</button>
                </div>
            </div>
            ${errorPreview}
            ${startupErrHtml}
        </div>`;
    }

    let showBuiltins = false;

    function toggleBuiltins() {
        showBuiltins = !showBuiltins;
        renderExtensionHealth();
    }

    function renderExtensionHealth() {
        const el = document.getElementById("fd-extension-health");
        if (!el) return;
        if (!metrics.extensionStatus.length) {
            el.innerHTML = '<div class="sd-webui-diagnostics-empty">No extensions detected. <button class="sd-webui-diagnostics-btn" style="margin-top:6px;" data-action="reload-backend">🔄 Retry</button></div>';
            return;
        }
        const installed = metrics.extensionStatus.filter((s) => !s.is_builtin);
        const builtin = metrics.extensionStatus.filter((s) => s.is_builtin);

        let html = "";
        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="font-size:11px;font-weight:700;color:#e0e0e0;">📦 Installed (${installed.length})</div>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;color:#9ca3af;">
                <input type="checkbox" ${showBuiltins ? "checked" : ""} data-action="toggle-builtins" style="cursor:pointer;">
                Show built-ins
            </label>
        </div>`;
        if (installed.length) {
            html += installed.map(_renderExtCard).join("");
        }
        if (showBuiltins && builtin.length) {
            html += `<div style="font-size:11px;font-weight:700;color:#9ca3af;margin:12px 0 8px;">🔧 Built-in Extensions (${builtin.length})</div>`;
            html += builtin.map(_renderExtCard).join("");
        }
        el.innerHTML = html;
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
        badge.title = `INP: ${fmtMs(v)}`;
        badge.className = "sd-webui-diagnostics-badge " + (v < 200 ? "ok" : v < 500 ? "warn" : "bad");
        updateIconView();
    }

    function updateClsBadge() {
        const badge = document.getElementById("fd-badge-cls");
        if (!badge) return;
        badge.textContent = `CLS ${metrics.cls.toFixed(3)}`;
        badge.title = `CLS: ${metrics.cls.toFixed(3)}`;
        badge.className = "sd-webui-diagnostics-badge " + (metrics.cls < 0.1 ? "ok" : metrics.cls < 0.25 ? "warn" : "bad");
    }

    function updateLcpBadge() {
        // LCP is not shown in the mini badge, only in full panel if needed
    }

    function updateStartupBadge() {
        if (panelState === 'expanded') renderStartup();
    }

    function updateHandlerBadge() {
        if (panelState === 'expanded') renderHandlers();
        updateInpBadge();
    }

    function updateMemoryBadge() {
        if (panelState === 'expanded') renderMemory();
        updateIconView();
    }



    function updateNetworkBadge() {
        const badge = document.getElementById("fd-badge-net");
        if (!badge) return;
        const last = metrics.network[metrics.network.length - 1];
        badge.textContent = last ? `NET ${fmtMs(last.duration)}` : "NET —";
        badge.title = last ? `Network: ${fmtMs(last.duration)}` : "Network: —";
        badge.className = "sd-webui-diagnostics-badge " + (!last ? "" : last.duration < 1000 ? "ok" : last.duration < 3000 ? "warn" : "bad");
    }

    function updateLongTaskBadge() {
        const badge = document.getElementById("fd-badge-lt");
        if (!badge) return;
        const count = metrics.longTasks.length;
        badge.textContent = `${count} LT`;
        badge.title = `${count} long tasks`;
        badge.className = "sd-webui-diagnostics-badge " + (count === 0 ? "ok" : "warn");
    }

    function updateFpsBadge() {
        const badge = document.getElementById("fd-badge-fps");
        if (!badge) return;
        const last = metrics.fps[metrics.fps.length - 1];
        badge.textContent = last ? `${last.fps} FPS` : "FPS —";
        badge.title = last ? `${last.fps} FPS (${last.dropped} dropped)` : "FPS: —";
        badge.className = "sd-webui-diagnostics-badge " + (!last ? "" : last.fps >= 50 ? "ok" : last.fps >= 30 ? "warn" : "bad");
        updateIconView();
    }

    function updateResourceBadge() {
        const badge = document.getElementById("fd-badge-res");
        if (!badge) return;
        const count = metrics.resources.length;
        badge.textContent = `${count} res`;
        badge.title = `${count} resources loaded`;
        badge.className = "sd-webui-diagnostics-badge";
    }

    function updateGradioBadge() {
        const badge = document.getElementById("fd-badge-gradio");
        if (!badge) return;
        const last = metrics.gradioCalls[metrics.gradioCalls.length - 1];
        badge.textContent = last ? `GRD ${fmtMs(last.duration)}` : "GRD —";
        badge.title = last ? `Gradio: ${fmtMs(last.duration)}` : "Gradio: —";
        badge.className = "sd-webui-diagnostics-badge " + (!last ? "" : last.duration < 2000 ? "ok" : last.duration < 5000 ? "warn" : "bad");
    }

    function updateErrorBadge() {
        const badge = document.getElementById("fd-badge-err");
        if (!badge) return;
        const count = metrics.errors.length;
        badge.textContent = `${count} err`;
        badge.title = `${count} errors`;
        badge.className = "sd-webui-diagnostics-badge " + (count === 0 ? "ok" : "bad");
        if (panelState === 'expanded') renderErrors();
        analyzeExtensionHealth();
        updateIconView();
    }

    function updateExtensionBadge() {
        const badge = document.getElementById("fd-badge-ext");
        if (!badge) return;
        const broken = metrics.extensionStatus.filter((s) => !s.healthy).length;
        badge.textContent = `${metrics.extensionStatus.length} ext`;
        badge.title = `${metrics.extensionStatus.length} extensions (${broken} with issues)`;
        badge.className = "sd-webui-diagnostics-badge " + (broken === 0 ? "ok" : "bad");
    }

    function updateCheckpointBadge() {
        const badge = document.getElementById("fd-badge-ckpt");
        if (!badge) return;
        badge.textContent = `${modelCounts.checkpoints} ckpt`;
        badge.title = `${modelCounts.checkpoints} checkpoints`;
    }

    function updateLoraBadge() {
        const badge = document.getElementById("fd-badge-lora");
        if (!badge) return;
        badge.textContent = `${modelCounts.loras} lora`;
        badge.title = `${modelCounts.loras} LoRAs`;
    }

    // ------------------------------------------------------------------
    // Auto-collapse after inactivity
    // ------------------------------------------------------------------
    function resetInactivityTimer() {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        if (panelState === 'expanded') {
            inactivityTimeout = setTimeout(() => {
                setPanelState(prevMinimizedState);
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
        if (panelState === 'expanded') render();
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
    let _initAttempts = 0;
    const MAX_INIT_ATTEMPTS = 30; // 15 seconds max (500ms interval)

    function init() {
        console.log("[SD-WebUI Diagnostics] init() started (attempt " + (_initAttempts + 1) + ")");
        if (window.__SD_WEBUI_DIAGNOSTICS_INIT__) {
            console.log("[SD-WebUI Diagnostics] Already initialized, skipping.");
            return;
        }

        const CFG = getConfig();
        console.log("[SD-WebUI Diagnostics] Config:", CFG);
        if (CFG.enabled === false) {
            console.log("[SD-WebUI Diagnostics] Widget disabled in Settings.");
            window.__SD_WEBUI_DIAGNOSTICS_INIT__ = true; // Mark as done so we don't retry
            return;
        }
        // NOTE: We intentionally do NOT gate on isMainTab here. Forge Neo / Gradio 4
        // renders DOM asynchronously and may place generation components inside shadow
        // DOMs or Vue portals, making simple querySelector checks unreliable. The widget
        // is useful on any page, and the user can disable it globally via Settings.
        console.log("[SD-WebUI Diagnostics] Proceeding with init (no DOM gate).");

        window.__SD_WEBUI_DIAGNOSTICS_INIT__ = true;
        console.log("[SD-WebUI Diagnostics] Creating panel...");
        createPanel();
        // Settings anchor has priority over localStorage so users can reset via Settings.
        const savedAnchor = CFG.position_anchor || localStorage.getItem('sd_diagnostics_anchor') || 'bottom-right';
        applyAnchor(savedAnchor);
        startMemoryPolling();
        startDomNodesObserver();
        updateDomNodesBadge();
        startFpsMeter();
        loadBackendState();
        setInterval(loadBackendState, 30000);
        console.log("[SD-WebUI Diagnostics] Profiler active. Click the 🔍 pill to open the panel.");
    }

    // Wait for Gradio root to be ready, then start retry loop
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
