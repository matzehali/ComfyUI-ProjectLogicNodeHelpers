try:
    from .nodes import NODE_CLASS_MAPPINGS as _NODE_CLASS_MAPPINGS
    from .version import NODE_VERSION, versioned_display_name

    # Leading Apple logo glyph (U+F8FF), matching the LTX Custom MLX scheme.
    PREFIX = ""

    NODE_CLASS_MAPPINGS = _NODE_CLASS_MAPPINGS

    NODE_DISPLAY_NAME_MAPPINGS = {
        "ProjectLogic": versioned_display_name(f"{PREFIX} Project Logic"),
        "ProjectLogicExtract": versioned_display_name(f"{PREFIX} Project Logic Extract"),
        "ProjectLogicPathSplit": versioned_display_name(f"{PREFIX} Project Logic Path Split"),
        "ProjectLogicRouterMaster": versioned_display_name(f"{PREFIX} Project Logic Router Master"),
        "ProjectLogicRouterSlave": versioned_display_name(f"{PREFIX} Project Logic Router Slave"),
        "ProjectLogicPreview": versioned_display_name(f"{PREFIX} Project Logic Preview"),
    }

    WEB_DIRECTORY = "./web"

    # Best-effort server routes for the folder-scanning dropdowns.
    try:
        from .server import register_routes
        register_routes()
    except Exception as route_err:  # pragma: no cover - non-fatal
        print(f"[ComfyUI-projectlogic] ⚠️  routes not registered: {route_err}")

    print(
        f"[ComfyUI-projectlogic] Nodes loaded {NODE_VERSION}: "
        + ", ".join(NODE_CLASS_MAPPINGS.keys())
    )

except Exception as e:
    print(f"[ComfyUI-projectlogic] ⚠️  Failed to load nodes: {e}")
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
