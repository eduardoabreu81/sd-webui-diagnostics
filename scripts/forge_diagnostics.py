"""
Forge Diagnostics — Backend registration for Forge Neo.

This module registers the extension so Forge Neo loads the frontend JS.
No settings, no endpoints, no state.
"""

import os

# Path to the extension root (used by Forge Neo to locate javascript/)
_extension_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
