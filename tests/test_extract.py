from pathlib import Path
import importlib.util
import json
import sys
import tempfile
import unittest
from unittest import mock

from comfy_execution.validation import validate_node_input
from comfyui_mlx_helpers import validate_output_dependencies


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "projectlogic_extract_test",
    ROOT / "__init__.py",
    submodule_search_locations=[str(ROOT)],
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

ProjectLogicExtract = MODULE.NODE_CLASS_MAPPINGS["ProjectLogicExtract"]
ProjectLogicConstants = MODULE.NODE_CLASS_MAPPINGS["ProjectLogicConstants"]
ProjectLogicRouterSlave = MODULE.NODE_CLASS_MAPPINGS["ProjectLogicRouterSlave"]
ProjectLogicPreview = MODULE.NODE_CLASS_MAPPINGS["ProjectLogicPreview"]
PackNoodles = MODULE.NODE_CLASS_MAPPINGS["PackNoodles"]
UnpackNoodles = MODULE.NODE_CLASS_MAPPINGS["UnpackNoodles"]
ProjectLogicSelectPath = MODULE.NODE_CLASS_MAPPINGS["ProjectLogicSelectPath"]
NODES = sys.modules[f"{SPEC.name}.nodes"]


def _prompt(directory, seed=2026071404):
    return {
        "1": {
            "class_type": "ProjectLogic",
            "inputs": {
                "project_path": str(directory),
                "shot": "GRD0040",
                "global_seed": seed,
                "default_template": "{root}/{shot}/{shot}_{type}/{shot}_{type}.####.{ext}",
                "output_template": "{root}/{shot}/{shot}_output/{shot}_output.{seed}.####.{ext}",
                "plate_clip": "",
                "passes_json": json.dumps([
                    {
                        "type": "obscura",
                        "ext": "exr",
                        "kind": "sequence",
                        "own_subfolder": True,
                        "template": "",
                    }
                ]),
            },
        },
        "extract": {
            "class_type": "ProjectLogicExtract",
            "inputs": {"pass_name": "obscura"},
        },
        "constants": {
            "class_type": "ProjectLogicConstants",
            "inputs": {},
        },
    }


class ExtractContractTests(unittest.TestCase):
    def test_extension_is_between_file_and_framecount(self):
        self.assertEqual(
            ProjectLogicExtract.RETURN_NAMES,
            (
                "full_path",
                "pathtofile",
                "file",
                "extension",
                "framecount",
                "seed",
                "file_type",
            ),
        )
        self.assertEqual(
            ProjectLogicExtract.RETURN_TYPES,
            (
                "STRING",
                "STRING",
                "STRING",
                "STRING",
                "INT",
                "INT",
                ["exr", "png", "jpg", "webp", "tiff"],
            ),
        )
        coco_type = ["exr", "png", "jpg", "webp", "tiff"]
        self.assertFalse(validate_node_input(ProjectLogicExtract.RETURN_TYPES[3], coco_type))
        self.assertTrue(validate_node_input(ProjectLogicExtract.RETURN_TYPES[6], coco_type))

    def test_all_value_nodes_have_complete_output_dependency_contracts(self):
        classes = (
            ProjectLogicExtract,
            ProjectLogicConstants,
            ProjectLogicRouterSlave,
            ProjectLogicPreview,
            PackNoodles,
            UnpackNoodles,
            ProjectLogicSelectPath,
        )
        for class_def in classes:
            with self.subTest(class_name=class_def.__name__):
                self.assertEqual(
                    set(validate_output_dependencies(class_def)),
                    set(range(len(class_def.RETURN_TYPES))),
                )

        traced_classes = (
            ProjectLogicExtract,
            ProjectLogicConstants,
            ProjectLogicRouterSlave,
            UnpackNoodles,
        )
        for class_def in traced_classes:
            with self.subTest(traced_class=class_def.__name__):
                hidden = class_def.INPUT_TYPES()["hidden"]
                self.assertEqual(hidden["unique_id"], "UNIQUE_ID")
                self.assertEqual(hidden["_mlx_partial_execution_targets"], "STRING")

        self.assertTrue(ProjectLogicExtract.INPUT_TYPES()["required"]["pass_name"][1]["lazy"])
        self.assertTrue(UnpackNoodles.INPUT_TYPES()["required"]["group"][1]["lazy"])
        router_inputs = ProjectLogicRouterSlave.INPUT_TYPES()
        self.assertTrue(router_inputs["optional"]["input_1"][1]["lazy"])
        self.assertNotIn("lazy", router_inputs["required"]["active_type"][1])

    def test_extract_returns_exact_strings_in_ui_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shot = "GRD0040"
            prompt = _prompt(root)

            response = ProjectLogicExtract().extract("obscura", prompt)
            result = response["result"]
            expected_dir = root / shot / f"{shot}_obscura"
            expected_full = expected_dir / f"{shot}_obscura.####.exr"

            self.assertEqual(result[0], str(expected_full))
            self.assertEqual(result[1], str(expected_dir))
            self.assertEqual(result[2], f"{shot}_obscura.####")
            self.assertEqual(result[3], "exr")
            self.assertEqual(result[4:], (0, 2026071404, "exr"))
            self.assertEqual(response["ui"]["resolved_strings"], list(result[:4]))
            self.assertEqual(response["ui"]["mlx_resolved_outputs"], [list(result)])

    def test_seed_preview_skips_path_input_and_frame_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            prompt = _prompt(directory)
            with mock.patch.object(
                NODES,
                "requested_outputs_for_node",
                return_value=frozenset({5}),
            ), mock.patch.object(
                NODES,
                "base_frame_count",
                side_effect=AssertionError("frame scan must stay pruned"),
            ):
                response = ProjectLogicExtract().extract(
                    pass_name=None,
                    prompt=prompt,
                    unique_id="extract",
                    _mlx_partial_execution_targets='["preview"]',
                )

            self.assertEqual(response["result"], (None, None, None, None, None, 2026071404, None))
            self.assertNotIn("resolved_strings", response["ui"])

    def test_file_type_preview_resolves_paths_without_frame_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            prompt = _prompt(directory)
            with mock.patch.object(
                NODES,
                "requested_outputs_for_node",
                return_value=frozenset({6}),
            ), mock.patch.object(
                NODES,
                "base_frame_count",
                side_effect=AssertionError("frame scan must stay pruned"),
            ):
                response = ProjectLogicExtract().extract(
                    "obscura",
                    prompt=prompt,
                    unique_id="extract",
                    _mlx_partial_execution_targets='["preview"]',
                )

            self.assertEqual(response["result"][6], "exr")
            self.assertIsNone(response["result"][4])
            self.assertIsNone(response["result"][5])

    def test_file_type_preview_rejects_non_coco_pass_extension(self):
        with tempfile.TemporaryDirectory() as directory:
            prompt = _prompt(directory)
            prompt["1"]["inputs"]["passes_json"] = json.dumps([
                {
                    "type": "movie",
                    "ext": "mov",
                    "kind": "movie",
                    "own_subfolder": True,
                    "template": "",
                }
            ])
            with mock.patch.object(
                NODES,
                "requested_outputs_for_node",
                return_value=frozenset({6}),
            ):
                with self.assertRaisesRegex(ValueError, "not accepted by CoCo Saver"):
                    ProjectLogicExtract().extract(
                        "movie",
                        prompt=prompt,
                        unique_id="extract",
                        _mlx_partial_execution_targets='["preview"]',
                    )

    def test_constants_seed_preview_does_not_count_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            prompt = _prompt(directory, seed=91)
            with mock.patch.object(
                NODES,
                "requested_outputs_for_node",
                return_value=frozenset({1}),
            ), mock.patch.object(
                NODES,
                "base_frame_count",
                side_effect=AssertionError("frame scan must stay pruned"),
            ):
                response = ProjectLogicConstants().constants(
                    prompt=prompt,
                    unique_id="constants",
                    _mlx_partial_execution_targets='["preview"]',
                )

            self.assertEqual(response["result"], (None, 91))
            self.assertEqual(response["ui"]["mlx_resolved_outputs"], [[None, 91]])

    def test_seed_preview_cache_keys_do_not_count_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            prompt = _prompt(directory, seed=91)
            with mock.patch.object(
                NODES,
                "requested_outputs_for_node",
                return_value=frozenset({5}),
            ), mock.patch.object(
                NODES,
                "base_frame_count",
                side_effect=AssertionError("extract cache key scanned frames"),
            ):
                extract_key = ProjectLogicExtract.IS_CHANGED(
                    pass_name=None,
                    prompt=prompt,
                    unique_id="extract",
                    _mlx_partial_execution_targets='["preview"]',
                )
            with mock.patch.object(
                NODES,
                "requested_outputs_for_node",
                return_value=frozenset({1}),
            ), mock.patch.object(
                NODES,
                "base_frame_count",
                side_effect=AssertionError("constants cache key scanned frames"),
            ):
                constants_key = ProjectLogicConstants.IS_CHANGED(
                    prompt=prompt,
                    unique_id="constants",
                    _mlx_partial_execution_targets='["preview"]',
                )

            self.assertEqual(extract_key, "(91,)")
            self.assertEqual(constants_key, "(91,)")

    def test_router_slave_requests_only_the_active_connected_branch(self):
        prompt = {
            "router": {
                "class_type": "ProjectLogicRouterSlave",
                "inputs": {
                    "active_type": "depth",
                    "slot_types": '["color", "depth"]',
                    "input_1": ["color_source", 0],
                    "input_2": ["depth_source", 0],
                },
            }
        }
        self.assertEqual(
            ProjectLogicRouterSlave().check_lazy_status(
                active_type="depth",
                slot_types='["color", "depth"]',
                prompt=prompt,
                unique_id="router",
            ),
            ["input_2"],
        )


if __name__ == "__main__":
    unittest.main()
