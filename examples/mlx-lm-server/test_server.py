import argparse
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("mlx_lm_example_server", SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(SERVER)


def write_pack(directory: Path, generation: dict | None = None) -> None:
    (directory / "config.json").write_text(
        json.dumps(
            {
                "model_type": SERVER.PACK_MODEL_TYPE,
                "base_model_type": "qwen3_5",
                "components": {"text": True, "vision": True},
            }
        )
    )
    if generation is not None:
        (directory / "generation_config.json").write_text(json.dumps(generation))


class DefaultBonsaiPackTests(unittest.TestCase):
    def test_default_serves_the_pinned_pack_on_a_local_non_conflicting_port(self):
        args = SERVER.parse_args([])
        launch = SERVER.resolve_launch(args)

        self.assertEqual(args.model, "prism-ml/Ternary-Bonsai-2.5-27B-mlx-2bit")
        self.assertEqual(launch.runtime, SERVER.PACK_RUNTIME)
        self.assertEqual(launch.revision, SERVER.DEFAULT_MODEL_REVISION)
        self.assertRegex(launch.revision, r"^[0-9a-f]{40}$")
        command = launch.command
        self.assertEqual(command[command.index("--model") + 1], SERVER.DEFAULT_MODEL)
        self.assertEqual(command[command.index("--host") + 1], "127.0.0.1")
        self.assertEqual(command[command.index("--port") + 1], "8081")
        self.assertEqual(
            command[command.index("--max-tokens") + 1],
            str(SERVER.MAX_CONTEXT_TOKENS),
        )
        # The pack's chat template thinks by default; mlx-vlm does not.
        self.assertIn("--enable-thinking", command)

    def test_thinking_default_follows_the_chat_template_arguments(self):
        args = SERVER.parse_args(
            ["--chat-template-args", '{"enable_thinking": false}']
        )
        self.assertNotIn("--enable-thinking", SERVER.resolve_launch(args).command)

        args = SERVER.parse_args(["--chat-template-args", '{"reasoning": "low"}'])
        with self.assertRaisesRegex(ValueError, "only enable_thinking"):
            SERVER.resolve_launch(args)

    def test_an_unreviewed_revision_needs_trust_remote_code(self):
        args = SERVER.parse_args(["--revision", "main"])
        with self.assertRaisesRegex(ValueError, "has not been reviewed"):
            SERVER.resolve_launch(args)

        args = SERVER.parse_args(["--revision", "main", "--trust-remote-code"])
        launch = SERVER.resolve_launch(args)
        self.assertEqual(launch.runtime, SERVER.PACK_RUNTIME)
        self.assertEqual(launch.revision, "main")

    def test_a_local_pack_directory_needs_trust_remote_code(self):
        with tempfile.TemporaryDirectory() as directory:
            write_pack(Path(directory))
            args = SERVER.parse_args(["--model", directory])
            with self.assertRaisesRegex(ValueError, "--trust-remote-code"):
                SERVER.resolve_launch(args)

            args = SERVER.parse_args(["--model", directory, "--trust-remote-code"])
            launch = SERVER.resolve_launch(args)
            self.assertEqual(launch.runtime, SERVER.PACK_RUNTIME)
            self.assertIsNone(launch.revision)
            self.assertEqual(launch.command[launch.command.index("--model") + 1], directory)

    def test_pack_sampling_defaults_come_from_generation_config(self):
        with tempfile.TemporaryDirectory() as directory:
            write_pack(
                Path(directory),
                {"do_sample": True, "temperature": 1.0, "top_k": 20, "top_p": 0.95},
            )
            self.assertEqual(
                SERVER.pack_sampling_defaults(Path(directory)),
                {"temperature": 1.0, "top_p": 0.95, "top_k": 20},
            )

            write_pack(Path(directory), {"do_sample": False, "temperature": 0.6})
            self.assertEqual(
                SERVER.pack_sampling_defaults(Path(directory)), {"temperature": 0.0}
            )

    def test_requests_cannot_load_another_model_or_adapter(self):
        served = SERVER.DEFAULT_MODEL
        inherit = object()

        def reason(model, adapter=inherit, kind="auto"):
            return SERVER.rejected_model_request(served, model, adapter, kind, inherit)

        self.assertIsNone(reason(served))
        self.assertIsNone(reason(served, None))
        self.assertIn("serves only", reason("mlx-community/other-model"))
        self.assertIn("serves only", reason(None))
        self.assertIn("Adapters", reason(served, "/tmp/adapter"))
        self.assertIn("not available", reason(served, kind="image_generation"))


class MlxLmServerTests(unittest.TestCase):
    def test_other_models_use_mlx_lm_server_with_forwarded_arguments(self):
        args = SERVER.parse_args(
            [
                "--model",
                "owner/model",
                "--port",
                "9000",
                "--chat-template-args",
                '{"enable_thinking": false}',
                "--trust-remote-code",
            ]
        )
        launch = SERVER.resolve_launch(args)
        command = launch.command

        self.assertEqual(launch.runtime, SERVER.MLX_LM_RUNTIME)
        self.assertEqual(command[:3], [sys.executable, "-m", "mlx_lm.server"])
        self.assertEqual(command[command.index("--model") + 1], "owner/model")
        self.assertEqual(command[command.index("--port") + 1], "9000")
        self.assertEqual(
            command[command.index("--allowed-origins") + 1],
            "http://localhost:5173,http://127.0.0.1:5173",
        )
        template_args = command[command.index("--chat-template-args") + 1]
        self.assertEqual(json.loads(template_args), {"enable_thinking": False})
        self.assertIn("--trust-remote-code", command)

    def test_revision_is_only_for_the_pack(self):
        args = SERVER.parse_args(["--model", "owner/model", "--revision", "main"])
        with self.assertRaisesRegex(ValueError, "only to the Bonsai pack"):
            SERVER.resolve_launch(args)

    def test_invalid_port_and_template_values_are_rejected(self):
        with self.assertRaises(argparse.ArgumentTypeError):
            SERVER.valid_port("70000")
        with self.assertRaises(argparse.ArgumentTypeError):
            SERVER.valid_max_tokens("262145")
        with self.assertRaises(argparse.ArgumentTypeError):
            SERVER.json_object("[]")
        with self.assertRaises(argparse.ArgumentTypeError):
            SERVER.json_object("{")


if __name__ == "__main__":
    unittest.main()
