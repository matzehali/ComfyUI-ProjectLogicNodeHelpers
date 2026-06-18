"""aiohttp routes backing the ProjectLogic JS dropdowns.

Exposes two read-only endpoints the frontend polls to populate the shot and
plate-clip combos:

    GET /projectlogic/subfolders?path=<project_path>  -> {"folders": [...]}
    GET /projectlogic/sequences?path=<shot_dir>       -> {"sequences": [...]}

Registration is best-effort: if ComfyUI's PromptServer/aiohttp are unavailable
the import simply no-ops so the nodes still load.
"""

from __future__ import annotations

from .paths import scan_sequences, scan_subfolders


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

    return True
