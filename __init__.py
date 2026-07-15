try:
    from .nodes import NODE_CLASS_MAPPINGS as _NODE_CLASS_MAPPINGS
    from .version import NODE_VERSION, versioned_display_name

    # Leading Apple logo glyph (U+F8FF), matching the LTX Custom MLX scheme.
    PREFIX = ""

    NODE_CLASS_MAPPINGS = _NODE_CLASS_MAPPINGS

    NODE_DISPLAY_NAME_MAPPINGS = {
        "ProjectLogic": versioned_display_name(f"{PREFIX} Project Logic Hub"),
        "ProjectLogicExtract": versioned_display_name(f"{PREFIX} Project Logic Extract"),
        "ProjectLogicConstants": versioned_display_name(f"{PREFIX} Project Logic Constants"),
        "ProjectLogicSelectPath": versioned_display_name(f"{PREFIX} Project Logic SelectPath"),
        "ProjectLogicRouterMaster": versioned_display_name(f"{PREFIX} Project Logic Router Master"),
        "ProjectLogicRouterSlave": versioned_display_name(f"{PREFIX} Project Logic Router Slave"),
        "ProjectLogicPreview": versioned_display_name(f"{PREFIX} Project Logic Preview"),
        "PackNoodles": versioned_display_name(f"{PREFIX} Pack Noodles"),
        "UnpackNoodles": versioned_display_name(f"{PREFIX} Unpack Noodles"),
    }

    WEB_DIRECTORY = "./web"

    # Copy the shared MLX node colors into our own web dir (we already serve ./web).
    try:
        import os as _os
        from comfyui_mlx_helpers import (
            install_node_colors as _install_node_colors,
            install_widget_input_sync as _install_widget_input_sync,
        )
        _web_dir = _os.path.join(_os.path.dirname(__file__), "web")
        _install_node_colors(_web_dir)
        _install_widget_input_sync(_web_dir)
    except Exception:
        pass

    # Best-effort server routes for the folder-scanning dropdowns.
    try:
        from .server import register_routes
        register_routes()
    except Exception as route_err:  # pragma: no cover - non-fatal
        print(f"[ComfyUI-ProjectLogicNodeHelpers] ⚠️  routes not registered: {route_err}")

    print(
        f"[ComfyUI-ProjectLogicNodeHelpers] Nodes loaded {NODE_VERSION}: "
        + ", ".join(NODE_CLASS_MAPPINGS.keys())
    )

except Exception as e:
    print(f"[ComfyUI-ProjectLogicNodeHelpers] ⚠️  Failed to load nodes: {e}")
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
