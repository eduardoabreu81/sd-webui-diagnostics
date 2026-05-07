"""
SD-WebUI Diagnostics — Backend registration for SD WebUI.

This module registers the extension so the WebUI loads the frontend JS.
No settings, no endpoints, no state.
"""

import os

# Path to the extension root (used by Forge Neo to locate javascript/)
_extension_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
