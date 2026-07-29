import argparse
import importlib.util
import json
import sys
import unittest
from pathlib import Path


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("mlx_lm_example_server", SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(SERVER)


class MlxLmServerLauncherTests(unittest.TestCase):
    def test_default_command_uses_local_non_conflicting_endpoint(self):
        args = SERVER.parse_args([])
        command = SERVER.build_server_command(args)

        self.assertEqual(args.host, "127.0.0.1")
        self.assertEqual(args.port, 8081)
        self.assertEqual(args.model, SERVER.DEFAULT_MODEL)
        self.assertEqual(args.max_tokens, SERVER.MAX_CONTEXT_TOKENS)
        self.assertEqual(command[:3], [sys.executable, "-m", "mlx_lm.server"])
        self.assertEqual(command[command.index("--port") + 1], "8081")
        self.assertEqual(
            command[command.index("--max-tokens") + 1],
            str(SERVER.MAX_CONTEXT_TOKENS),
        )

    def test_custom_model_and_chat_template_arguments_are_forwarded(self):
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
        command = SERVER.build_server_command(args)

        self.assertEqual(command[command.index("--model") + 1], "owner/model")
        self.assertEqual(command[command.index("--port") + 1], "9000")
        template_args = command[command.index("--chat-template-args") + 1]
        self.assertEqual(json.loads(template_args), {"enable_thinking": False})
        self.assertIn("--trust-remote-code", command)

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
