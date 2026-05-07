"""
SD-WebUI Diagnostics — Backend registration, settings, and extension tracing.

Traces extension callback execution times and exposes a state endpoint
so the frontend can show real extension data instead of DOM heuristics.
"""

import json
import os
import time
import traceback

_EXTENSION_PATH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CONFIG_JS_PATH = os.path.join(_EXTENSION_PATH, "javascript", "diagnostics_config.js")
_STATE_JS_PATH = os.path.join(_EXTENSION_PATH, "javascript", "diagnostics_state.js")

_SETTINGS = [
    ("show_inp", True, "Show INP badge"),
    ("show_cls", True, "Show CLS badge"),
    ("show_fps", True, "Show FPS badge"),
    ("show_net", True, "Show Network badge"),
    ("show_lt", True, "Show Long Tasks badge"),
    ("show_err", True, "Show Errors badge"),
    ("show_dom", True, "Show DOM nodes badge"),
    ("show_res", True, "Show Resources badge"),
    ("show_gradio", True, "Show Gradio calls badge"),
    ("show_extension_health", True, "Show Extension Health tab"),
]

# ------------------------------------------------------------------------------
# Tracer: monkey-patch script_callbacks to measure per-extension startup time
# ------------------------------------------------------------------------------
_extension_timings = {}  # {ext_name: {"total_ms": float, "callbacks": int}}


def _install_callback_tracer():
    """Wrap script_callbacks.call_callback to record per-extension timing."""
    try:
        import modules.script_callbacks as sc

        _orig = sc.call_callback

        def _traced(callbacks, *args, **kwargs):
            for c in callbacks:
                mod = getattr(c, "__module__", "")
                ext = _module_to_extension(mod)
                t0 = time.time()
                try:
                    result = c(*args, **kwargs)
                    if result is not None:
                        yield result
                except Exception:
                    raise
                finally:
                    elapsed = (time.time() - t0) * 1000
                    entry = _extension_timings.setdefault(ext, {"total_ms": 0.0, "callbacks": 0})
                    entry["total_ms"] += elapsed
                    entry["callbacks"] += 1

        sc.call_callback = _traced
    except Exception:
        traceback.print_exc()


def _module_to_extension(module_name: str) -> str:
    """Extract extension folder name from module path."""
    if not module_name or not module_name.startswith("extensions."):
        return "webui-core"
    parts = module_name.split(".")
    return parts[1] if len(parts) > 1 else "unknown"


# ------------------------------------------------------------------------------
# Extension metadata
# ------------------------------------------------------------------------------
def _get_extensions():
    """Return list of extension metadata from modules.extensions."""
    try:
        from modules import extensions

        out = []
        for ext in getattr(extensions, "extensions", []):
            name = getattr(ext, "name", "unknown")
            timing = _extension_timings.get(name, {"total_ms": 0.0, "callbacks": 0})
            out.append(
                {
                    "name": name,
                    "path": getattr(ext, "path", None),
                    "enabled": getattr(ext, "enabled", False),
                    "version": getattr(ext, "version", None),
                    "remote": getattr(ext, "remote", None),
                    "branch": getattr(ext, "branch", None),
                    "startup_ms": round(timing["total_ms"], 1),
                    "callbacks": timing["callbacks"],
                }
            )
        return out
    except Exception:
        traceback.print_exc()
        return []


# ------------------------------------------------------------------------------
# JS file writers (fallback when endpoint is unavailable)
# ------------------------------------------------------------------------------
def _write_config_js():
    try:
        from modules import shared

        cfg = {}
        for key, default, _label in _SETTINGS:
            opt_key = f"sdwebui_diagnostics_{key}"
            cfg[key] = getattr(shared.opts, opt_key, default)

        js = f"window.SD_WEBUI_DIAGNOSTICS_CONFIG = {json.dumps(cfg, indent=2)};\n"
        with open(_CONFIG_JS_PATH, "w", encoding="utf-8") as f:
            f.write(js)
    except Exception:
        pass


def _write_state_js():
    """Write current extension state to a JS file for frontend fallback."""
    try:
        state = {"extensions": _get_extensions()}
        js = f"window.SD_WEBUI_DIAGNOSTICS_STATE = {json.dumps(state, indent=2)};\n"
        with open(_STATE_JS_PATH, "w", encoding="utf-8") as f:
            f.write(js)
    except Exception:
        pass


# ------------------------------------------------------------------------------
# WebUI integration
# ------------------------------------------------------------------------------
try:
    from modules import script_callbacks, shared

    def on_ui_settings():
        section = ("sd-webui-diagnostics", "SD-WebUI Diagnostics")
        for key, default, label in _SETTINGS:
            shared.opts.add_option(
                f"sdwebui_diagnostics_{key}",
                shared.OptionInfo(default, label, section=section),
            )

    def on_app_started(_demo, app):
        """Register FastAPI endpoint for live state queries."""
        try:
            from fastapi.responses import JSONResponse

            @app.get("/sd-webui-diagnostics/api/state")
            def api_state():
                return JSONResponse(
                    {
                        "extensions": _get_extensions(),
                        "traced": len(_extension_timings) > 0,
                    }
                )
        except Exception:
            traceback.print_exc()

        # Also write static fallback file
        _write_state_js()

    script_callbacks.on_ui_settings(on_ui_settings)
    script_callbacks.on_before_reload(_write_config_js)
    script_callbacks.on_app_started(on_app_started)

    # Install tracer immediately so it catches early callbacks
    _install_callback_tracer()

    # Write fallback files so they exist before first page load
    _write_config_js()
    _write_state_js()

except Exception:
    traceback.print_exc()
