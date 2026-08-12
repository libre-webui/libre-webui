import ast
import asyncio
import json
import math
import re
import tempfile
import unittest
import unicodedata
from pathlib import Path
from unittest.mock import patch


EXAMPLE_DIRECTORY = Path(__file__).resolve().parent
SERVER_PATH = EXAMPLE_DIRECTORY / "server.py"
MANIFEST_PATH = EXAMPLE_DIRECTORY.parents[1] / "plugins" / "longcat-audiodit.json"
HELPER_NAMES = {
    "sanitize_text",
    "prepare_text",
    "approximate_duration_from_text",
    "estimate_clone_generated_duration",
    "validate_model_id",
    "validate_loaded_model_id",
    "models_response",
    "validate_generation_parameters",
    "validate_ignored_openai_speed",
    "validate_upload_metadata",
    "persist_reference_upload",
}
CONSTANT_NAMES = {
    "OFFICIAL_MODEL_IDS",
    "DEFAULT_MODEL_ID",
    "MAX_INPUT_CHARACTERS",
    "MAX_REFERENCE_AUDIO_BYTES",
    "UPLOAD_CHUNK_BYTES",
    "MIN_STEPS",
    "MAX_STEPS",
    "MIN_CFG_STRENGTH",
    "MAX_CFG_STRENGTH",
    "MAX_SEED",
    "MIN_OPENAI_SPEED",
    "MAX_OPENAI_SPEED",
    "MIME_TYPE_SUFFIXES",
}


def load_pure_helpers():
    tree = ast.parse(SERVER_PATH.read_text(encoding="utf-8"), filename=str(SERVER_PATH))
    selected_nodes = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in CONSTANT_NAMES
            for target in node.targets
        ):
            selected_nodes.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in HELPER_NAMES:
                selected_nodes.append(node)

    namespace = {
        "math": math,
        "re": re,
        "unicodedata": unicodedata,
        "tempfile": tempfile,
        "Path": Path,
        "UploadFile": object,
    }
    helper_module = ast.Module(body=selected_nodes, type_ignores=[])
    exec(compile(helper_module, str(SERVER_PATH), "exec"), namespace)
    return namespace


HELPERS = load_pure_helpers()


class LongCatAdapterValidationTests(unittest.TestCase):
    def test_sanitization_preserves_english_and_chinese(self):
        sanitize_text = HELPERS["sanitize_text"]
        self.assertEqual(
            sanitize_text('  “Hello”\u200b\n世界\tTEST  '),
            "hello 世界 test",
        )

    def test_prepare_text_rejects_empty_punctuation_and_oversized_input(self):
        prepare_text = HELPERS["prepare_text"]
        for value in ("", " \u200b ", "...?!"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "spoken text"):
                    prepare_text(value, "input", 10)

        with self.assertRaisesRegex(ValueError, "10-character"):
            prepare_text("a" * 11, "input", 10)

    def test_official_duration_heuristic_is_bounded(self):
        approximate = HELPERS["approximate_duration_from_text"]
        self.assertAlmostEqual(approximate("abcd", 30.0), 4 * 0.082)
        self.assertAlmostEqual(approximate("中文", 30.0), 2 * 0.21)
        self.assertEqual(approximate("a" * 10_000, 2.0), 2.0)

    def test_clone_duration_rejects_text_that_would_be_clipped(self):
        estimate = HELPERS["estimate_clone_generated_duration"]
        self.assertLess(
            estimate("short reply", "matching reference", 4.0, 30.0),
            26.0,
        )
        with self.assertRaisesRegex(ValueError, "remaining voice-clone duration"):
            estimate("中" * 140, "中" * 70, 15.0, 30.0)

    def test_only_official_model_ids_are_accepted(self):
        validate_model_id = HELPERS["validate_model_id"]
        for model_id in HELPERS["OFFICIAL_MODEL_IDS"]:
            self.assertEqual(validate_model_id(model_id), model_id)

        with self.assertRaisesRegex(ValueError, "model must be one of"):
            validate_model_id("longcat-unofficial")

    def test_catalog_contains_only_the_loaded_checkpoint(self):
        model_ids = HELPERS["OFFICIAL_MODEL_IDS"]
        response = HELPERS["models_response"](model_ids[1])
        self.assertEqual(response["object"], "list")
        self.assertEqual([item["id"] for item in response["data"]], [model_ids[1]])

        validate_loaded = HELPERS["validate_loaded_model_id"]
        self.assertEqual(validate_loaded(model_ids[0], model_ids[0]), model_ids[0])
        with self.assertRaisesRegex(ValueError, "restart it to use"):
            validate_loaded(model_ids[1], model_ids[0])

    def test_generation_controls_are_strictly_bounded(self):
        validate = HELPERS["validate_generation_parameters"]
        self.assertEqual(validate(16, 4, "apg", 1024), (16, 4.0, "apg", 1024))

        invalid_cases = (
            (1, 4.0, "cfg", 1),
            (65, 4.0, "cfg", 1),
            (16, float("nan"), "cfg", 1),
            (16, 21.0, "cfg", 1),
            (16, 4.0, "unknown", 1),
            (16, 4.0, "cfg", -1),
            (16, 4.0, "cfg", HELPERS["MAX_SEED"] + 1),
        )
        for parameters in invalid_cases:
            with self.subTest(parameters=parameters):
                with self.assertRaises(ValueError):
                    validate(*parameters)

    def test_openai_speed_range_is_accepted_and_ignored(self):
        validate = HELPERS["validate_ignored_openai_speed"]
        for speed in (0.25, 0.5, 1.0, 1.5, 2.0, 4.0):
            with self.subTest(speed=speed):
                self.assertEqual(validate(speed), speed)

        for speed in (0.249, 4.001, float("nan"), float("inf"), True, "1.0"):
            with self.subTest(speed=speed):
                with self.assertRaises(ValueError):
                    validate(speed)

    def test_upload_type_and_declared_size_are_bounded(self):
        validate_upload = HELPERS["validate_upload_metadata"]
        self.assertEqual(validate_upload("audio/wav; charset=binary", 10), ".wav")
        self.assertEqual(validate_upload("audio/mpeg", None), ".mp3")

        with self.assertRaisesRegex(ValueError, "must use one of"):
            validate_upload("application/octet-stream", 10)
        with self.assertRaisesRegex(OverflowError, "byte limit"):
            validate_upload(
                "audio/wav", HELPERS["MAX_REFERENCE_AUDIO_BYTES"] + 1
            )

    def test_partial_temporary_upload_is_removed_after_overflow(self):
        class FakeUpload:
            def __init__(self):
                self.chunks = [b"12345", b"6789", b""]
                self.closed = False

            async def read(self, _: int) -> bytes:
                return self.chunks.pop(0)

            async def close(self) -> None:
                self.closed = True

        upload = FakeUpload()
        created_paths = []
        real_named_temporary_file = tempfile.NamedTemporaryFile

        def record_temporary_file(*args, **kwargs):
            temporary_file = real_named_temporary_file(*args, **kwargs)
            created_paths.append(Path(temporary_file.name))
            return temporary_file

        with (
            patch.dict(
                HELPERS,
                {"MAX_REFERENCE_AUDIO_BYTES": 8, "UPLOAD_CHUNK_BYTES": 5},
            ),
            patch.object(
                tempfile,
                "NamedTemporaryFile",
                side_effect=record_temporary_file,
            ),
        ):
            with self.assertRaisesRegex(OverflowError, "byte limit"):
                asyncio.run(HELPERS["persist_reference_upload"](upload, ".wav"))

        self.assertTrue(upload.closed)
        self.assertEqual(len(created_paths), 1)
        self.assertFalse(created_paths[0].exists())


class LongCatManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        self.config = self.manifest["capabilities"]["tts"]["config"]

    def test_manifest_uses_official_models_and_authless_local_endpoints(self):
        official_models = list(HELPERS["OFFICIAL_MODEL_IDS"])
        self.assertEqual(self.manifest["model_map"], official_models)
        self.assertEqual(
            self.manifest["capabilities"]["tts"]["model_map"], official_models
        )
        self.assertEqual(
            self.manifest["endpoint"],
            "http://localhost:8300/v1/audio/speech",
        )
        self.assertEqual(
            self.manifest["capabilities"]["tts"]["models_endpoint"],
            "http://localhost:8300/v1/models",
        )
        self.assertEqual(self.manifest["auth"], {"header": "", "key_env": ""})
        self.assertTrue(self.config["no_auth_required"])

    def test_manifest_does_not_invent_named_voices(self):
        self.assertEqual(self.config["voices"], [])
        self.assertEqual(self.config["default_voice"], "")
        self.assertEqual(self.config["formats"], ["wav"])
        self.assertEqual(self.config["default_format"], "wav")
        self.assertEqual(
            self.config["max_characters"], HELPERS["MAX_INPUT_CHARACTERS"]
        )
        self.assertEqual(self.config["max_characters"], 140)

    def test_manifest_declares_complete_clone_contract(self):
        self.assertTrue(self.config["supports_voice_cloning"])
        self.assertEqual(
            self.config["voice_clone_endpoint"],
            "http://localhost:8300/v1/audio/voice-clone",
        )
        self.assertEqual(
            self.config["voice_clone_endpoint_variable"],
            "voice_clone_endpoint",
        )
        self.assertTrue(self.config["clone_requires_transcript"])
        self.assertEqual(
            self.config["clone_max_audio_bytes"],
            HELPERS["MAX_REFERENCE_AUDIO_BYTES"],
        )
        self.assertEqual(
            set(self.config["clone_audio_mime_types"]),
            set(HELPERS["MIME_TYPE_SUFFIXES"]),
        )

    def test_manifest_exposes_expected_adapter_variables(self):
        variables = {item["name"]: item for item in self.manifest["variables"]}
        self.assertEqual(
            set(variables),
            {
                "endpoint",
                "models_endpoint",
                "voice_clone_endpoint",
                "steps",
                "cfg_strength",
                "guidance_method",
                "seed",
            },
        )
        self.assertEqual(variables["steps"]["default"], 16)
        self.assertEqual(variables["cfg_strength"]["default"], 4)
        self.assertEqual(variables["guidance_method"]["options"], ["cfg", "apg"])
        self.assertEqual(variables["seed"]["default"], 1024)
        self.assertEqual(
            self.config["request_variables"],
            ["steps", "cfg_strength", "guidance_method", "seed"],
        )


if __name__ == "__main__":
    unittest.main()
