from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import unittest

COMFY_ROOT = "/Applications/ComfyUI"
if sys.path[0] != COMFY_ROOT:
    sys.path.insert(0, COMFY_ROOT)

import execution
import nodes as comfy_nodes


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "projectlogic_execution_test",
    ROOT / "__init__.py",
    submodule_search_locations=[str(ROOT)],
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


RUNS = {}


class _FailingPassNameSource:
    RETURN_TYPES = ("STRING",)
    FUNCTION = "run"
    CATEGORY = "test"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def run(self):
        RUNS["pass_name"] += 1
        raise AssertionError("pass-name branch executed during seed preview")


class _BranchSource:
    RETURN_TYPES = ("STRING",)
    FUNCTION = "run"
    CATEGORY = "test"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"name": ("STRING",)}}

    def run(self, name):
        RUNS[name] += 1
        if name == "color":
            raise AssertionError("inactive router branch executed")
        return (name,)


class _IntPreview:
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "test"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"value": ("INT",)}}

    def run(self, value):
        RUNS["preview"] += 1
        assert value == 73
        return ()


class _AnyPreview:
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "test"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"value": ("*",)}}

    def run(self, value):
        RUNS["preview"] += 1
        assert value == "depth"
        return ()


class _StringRoot:
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "test"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"value": ("STRING",)}}

    def run(self, value):
        RUNS["other_root"] += 1
        return ()


class _Server:
    client_id = None
    last_node_id = None

    def send_sync(self, *args, **kwargs):
        pass


async def _run_partial(prompt, target):
    valid, error, outputs, node_errors = await execution.validate_prompt(
        "projectlogic-probe",
        prompt,
        [target],
    )
    if not valid:
        raise AssertionError((error, node_errors))
    executor = execution.PromptExecutor(
        _Server(),
        cache_type=execution.CacheType.NONE,
        cache_args={"ram": 0, "ram_inactive": 0},
    )
    await executor.execute_async(
        prompt,
        "projectlogic-probe",
        execute_outputs=outputs,
    )
    if not executor.success:
        raise AssertionError(executor.status_messages)


class RealComfyExecutionPathTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registered = dict(MODULE.NODE_CLASS_MAPPINGS)
        cls.registered.update(
            {
                "TraceFailingPassNameSource": _FailingPassNameSource,
                "TraceBranchSource": _BranchSource,
                "TraceIntPreview": _IntPreview,
                "TraceAnyPreview": _AnyPreview,
                "TraceStringRoot": _StringRoot,
            }
        )
        cls.old = {
            name: comfy_nodes.NODE_CLASS_MAPPINGS.get(name)
            for name in cls.registered
        }
        comfy_nodes.NODE_CLASS_MAPPINGS.update(cls.registered)

    @classmethod
    def tearDownClass(cls):
        for name, value in cls.old.items():
            if value is None:
                comfy_nodes.NODE_CLASS_MAPPINGS.pop(name, None)
            else:
                comfy_nodes.NODE_CLASS_MAPPINGS[name] = value

    def test_seed_preview_does_not_execute_linked_pass_name_or_other_root(self):
        RUNS.clear()
        RUNS.update({"pass_name": 0, "preview": 0, "other_root": 0})
        prompt = {
            "hub": {
                "class_type": "ProjectLogic",
                "inputs": {
                    "project_path": "/tmp",
                    "shot": "TRACE",
                    "global_seed": 73,
                    "default_template": "{root}/{shot}/{shot}_{type}/{shot}_{type}.####.{ext}",
                    "output_template": "{root}/{shot}/{shot}_output/{shot}_output.{seed}.####.{ext}",
                    "plate_clip": "",
                    "passes_json": json.dumps(
                        [{"type": "base", "ext": "exr", "kind": "sequence"}]
                    ),
                },
            },
            "pass_name": {"class_type": "TraceFailingPassNameSource", "inputs": {}},
            "extract": {
                "class_type": "ProjectLogicExtract",
                "inputs": {
                    "pass_name": ["pass_name", 0],
                    "_mlx_partial_execution_targets": '["preview"]',
                },
            },
            "preview": {
                "class_type": "TraceIntPreview",
                "inputs": {"value": ["extract", 5]},
            },
            "other": {
                "class_type": "TraceStringRoot",
                "inputs": {"value": ["extract", 0]},
            },
        }

        asyncio.run(_run_partial(prompt, "preview"))

        self.assertEqual(
            RUNS,
            {"pass_name": 0, "preview": 1, "other_root": 0},
        )

    def test_router_executes_only_its_active_input_branch(self):
        RUNS.clear()
        RUNS.update({"color": 0, "depth": 0, "preview": 0})
        prompt = {
            "color": {
                "class_type": "TraceBranchSource",
                "inputs": {"name": "color"},
            },
            "depth": {
                "class_type": "TraceBranchSource",
                "inputs": {"name": "depth"},
            },
            "router": {
                "class_type": "ProjectLogicRouterSlave",
                "inputs": {
                    "master": "passes",
                    "router_id": "master-1",
                    "active_type": "depth",
                    "slot_types": '["color", "depth"]',
                    "input_1": ["color", 0],
                    "input_2": ["depth", 0],
                    "_mlx_partial_execution_targets": '["preview"]',
                },
            },
            "preview": {
                "class_type": "TraceAnyPreview",
                "inputs": {"value": ["router", 0]},
            },
        }

        asyncio.run(_run_partial(prompt, "preview"))

        self.assertEqual(RUNS, {"color": 0, "depth": 1, "preview": 1})

    def test_router_falls_back_to_first_connected_branch_without_scanning_others(self):
        RUNS.clear()
        RUNS.update({"color": 0, "depth": 0, "preview": 0})
        prompt = {
            "depth": {
                "class_type": "TraceBranchSource",
                "inputs": {"name": "depth"},
            },
            "router": {
                "class_type": "ProjectLogicRouterSlave",
                "inputs": {
                    "master": "passes",
                    "router_id": "master-1",
                    "active_type": "color",
                    "slot_types": '["depth", "color"]',
                    "input_1": ["depth", 0],
                    "_mlx_partial_execution_targets": '["preview"]',
                },
            },
            "preview": {
                "class_type": "TraceAnyPreview",
                "inputs": {"value": ["router", 0]},
            },
        }

        asyncio.run(_run_partial(prompt, "preview"))

        self.assertEqual(RUNS, {"color": 0, "depth": 1, "preview": 1})


if __name__ == "__main__":
    unittest.main()
