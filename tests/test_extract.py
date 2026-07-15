from pathlib import Path
import importlib.util
import json
import sys
import tempfile
import unittest


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


class ExtractContractTests(unittest.TestCase):
    def test_extension_is_between_file_and_framecount(self):
        self.assertEqual(
            ProjectLogicExtract.RETURN_NAMES,
            ("full_path", "pathtofile", "file", "extension", "framecount", "seed"),
        )
        self.assertEqual(
            ProjectLogicExtract.RETURN_TYPES,
            ("STRING", "STRING", "STRING", "STRING", "INT", "INT"),
        )

    def test_extract_returns_exact_strings_in_ui_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shot = "GRD0040"
            pass_config = json.dumps([
                {
                    "type": "obscura",
                    "ext": "exr",
                    "kind": "sequence",
                    "own_subfolder": True,
                    "template": "",
                }
            ])
            prompt = {
                "1": {
                    "class_type": "ProjectLogic",
                    "inputs": {
                        "project_path": str(root),
                        "shot": shot,
                        "global_seed": 2026071404,
                        "default_template": "{root}/{shot}/{shot}_{type}/{shot}_{type}.####.{ext}",
                        "output_template": "{root}/{shot}/{shot}_output/{shot}_output.{seed}.####.{ext}",
                        "plate_clip": "",
                        "passes_json": pass_config,
                    },
                }
            }

            response = ProjectLogicExtract().extract("obscura", prompt)
            result = response["result"]
            expected_dir = root / shot / f"{shot}_obscura"
            expected_full = expected_dir / f"{shot}_obscura.####.exr"

            self.assertEqual(result[0], str(expected_full))
            self.assertEqual(result[1], str(expected_dir))
            self.assertEqual(result[2], f"{shot}_obscura.####")
            self.assertEqual(result[3], "exr")
            self.assertEqual(result[4:], (0, 2026071404))
            self.assertEqual(response["ui"]["resolved_strings"], list(result[:4]))


if __name__ == "__main__":
    unittest.main()
