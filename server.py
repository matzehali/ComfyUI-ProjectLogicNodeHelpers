"""aiohttp routes backing the ProjectLogic JS dropdowns + native path picker.

    GET /projectlogic/subfolders?path=<project_path>  -> {"folders": [...]}
    GET /projectlogic/sequences?path=<shot_dir>       -> {"sequences": [...]}
    GET /projectlogic/browse?mode=folder|file         -> {"path": "<chosen>"}

The browse route opens a native OS dialog on the **server host** (intended for
local ComfyUI). Registration is best-effort: if ComfyUI's PromptServer/aiohttp
are unavailable the import simply no-ops so the nodes still load.
"""

from __future__ import annotations

import subprocess
import sys

from .paths import scan_sequences, scan_subfolders


def native_path_dialog(mode: str = "folder") -> str:
    """Open a native file/folder picker on the host and return the chosen path.

    Returns "" on cancel or if no dialog backend is available. Blocking — call
    it from a thread executor so the server event loop stays responsive.
    """
    want_file = mode == "file"

    if sys.platform == "darwin":
        chooser = "choose file" if want_file else "choose folder"
        # Bring the dialog to the front, then return its POSIX path.
        script = (
            'tell application "System Events" to activate\n'
            f"POSIX path of ({chooser})"
        )
        try:
            res = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True, timeout=600,
            )
            if res.returncode == 0:
                return res.stdout.strip()
        except Exception:
            pass
        return ""  # user cancelled or osascript failed

    # Cross-platform fallback (Windows / Linux with a display).
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        path = (
            filedialog.askopenfilename() if want_file else filedialog.askdirectory()
        )
        root.destroy()
        return path or ""
    except Exception:
        return ""


def register_routes() -> bool:
    try:
        from server import PromptServer  # provided by ComfyUI at runtime
        from aiohttp import web
    except Exception:
        return False

    instance = getattr(PromptServer, "instance", None)
    if instance is None or not hasattr(instance, "routes"):
        return False

    routes = instance.routes

    @routes.get("/projectlogic/subfolders")
    async def _subfolders(request):
        path = request.query.get("path", "")
        return web.json_response({"folders": scan_subfolders(path)})

    @routes.get("/projectlogic/sequences")
    async def _sequences(request):
        path = request.query.get("path", "")
        return web.json_response({"sequences": scan_sequences(path)})

    @routes.get("/projectlogic/browse")
    async def _browse(request):
        import asyncio
        mode = request.query.get("mode", "folder")
        loop = asyncio.get_event_loop()
        # Run the blocking dialog off the event loop.
        path = await loop.run_in_executor(None, native_path_dialog, mode)
        return web.json_response({"path": path})

    return True
