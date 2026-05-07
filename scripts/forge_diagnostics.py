"""
SD-WebUI Diagnostics — Backend registration and settings for SD WebUI.

Registers the extension path and exposes Settings toggles so users
can choose which badges and tabs are visible in the diagnostics panel.
"""

import json
import os

# Path to the extension root (used by the WebUI to locate javascript/)
_EXTENSION_PATH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CONFIG_JS_PATH = os.path.join(_EXTENSION_PATH, "javascript", "diagnostics_config.js")

# Settings exposed to the WebUI Settings page
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


def _write_config_js():
    """Persist current settings to a JS file the frontend can read."""
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


try:
    from modules import script_callbacks, shared

    def on_ui_settings():
        section = ("sd-webui-diagnostics", "SD-WebUI Diagnostics")
        for key, default, label in _SETTINGS:
            shared.opts.add_option(
                f"sdwebui_diagnostics_{key}",
                shared.OptionInfo(default, label, section=section),
            )

    script_callbacks.on_ui_settings(on_ui_settings)
    # Write config whenever the WebUI reloads scripts or settings change
    script_callbacks.on_before_reload(_write_config_js)

    # Also write immediately so the file exists before the first page load
    _write_config_js()

except Exception:
    pass
