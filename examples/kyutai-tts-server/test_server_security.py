import ast
import asyncio
import os
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import suppress
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from urllib.parse import urlsplit


SERVER_PATH = Path(__file__).with_name("server.py")
HELPER_NAMES = {
    "get_voice_state",
    "is_emoji_character",
    "is_remote_voice_reference",
    "sanitize_text",
    "strip_markdown_links",
    "strip_parenthetical_stage_directions",
}
CONSTANT_NAMES = {
    "EMOJI_CODEPOINT_RANGES",
    "EMOJI_CODEPOINTS",
}


def load_security_helpers():
    """Load pure helpers without importing the example's optional ML stack."""
    tree = ast.parse(
        SERVER_PATH.read_text(encoding="utf-8"),
        filename=str(SERVER_PATH),
    )
    selected_nodes = []

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in HELPER_NAMES:
                selected_nodes.append(node)
            continue

        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in CONSTANT_NAMES
            for target in node.targets
        ):
            selected_nodes.append(node)

    namespace = {"re": re, "urlsplit": urlsplit}
    helper_module = ast.Module(body=selected_nodes, type_ignores=[])
    exec(compile(helper_module, str(SERVER_PATH), "exec"), namespace)
    return namespace


class RecordingModel:
    def __init__(self):
        self.references = []

    def get_state_for_audio_prompt(self, reference):
        self.references.append(reference)
        return f"state:{reference}"


class KyutaiServerSecurityTests(unittest.TestCase):
    def setUp(self):
        self.helpers = load_security_helpers()
        self.model = RecordingModel()
        self.helpers.update(
            {
                "BUILTIN_VOICES": {"alba": {}},
                "VOICE_ALIASES": {"alloy": "alba"},
                "model": self.model,
                "voice_states": {"alba": "state:alba"},
            }
        )

    def test_local_paths_never_reach_the_model(self):
        get_voice_state = self.helpers["get_voice_state"]

        references = ("/etc/passwd", "../private.wav", "file:///tmp/voice.wav")
        for reference in references:
            with self.subTest(reference=reference):
                self.assertEqual(get_voice_state(reference), "state:alba")

        self.assertEqual(self.model.references, [])

    def test_only_well_formed_remote_voice_references_are_accepted(self):
        is_remote_voice_reference = self.helpers["is_remote_voice_reference"]

        self.assertTrue(
            is_remote_voice_reference(
                "hf://kyutai/tts-voices/alba-mackenna/casual.wav"
            )
        )
        self.assertTrue(
            is_remote_voice_reference(
                "https://huggingface.co/kyutai/tts-voices/resolve/main/voice.wav"
            )
        )
        self.assertFalse(is_remote_voice_reference("https:///missing-host.wav"))
        self.assertFalse(is_remote_voice_reference("httpx://example.com/voice.wav"))
        self.assertFalse(is_remote_voice_reference("voice.wav"))

    def test_sanitization_preserves_non_emoji_unicode(self):
        sanitize_text = self.helpers["sanitize_text"]
        text = (
            "Hello 😀 world. 你好 [Libre](https://librewebui.org) "
            "*(warmly)*"
        )

        self.assertEqual(sanitize_text(text), "Hello world. 你好 Libre")

    def test_sanitization_handles_large_malformed_markup_linearly(self):
        sanitize_text = self.helpers["sanitize_text"]
        malformed_link = "[" * 50_000 + "]"
        stage_direction = "(" + ("quiet " * 20_000) + ")"

        self.assertEqual(sanitize_text(malformed_link), malformed_link)
        self.assertEqual(
            sanitize_text(f"before {stage_direction} after"),
            "before after",
        )


class VoiceCloneCleanupTests(unittest.TestCase):
    SERVER_PATHS = (
        SERVER_PATH,
        SERVER_PATH.parents[1] / "qwen-tts-server" / "server.py",
    )

    def load_endpoint(self, server_path, temporary_directory):
        """Exercise both clone handlers without loading optional model packages."""
        tree = ast.parse(server_path.read_text(encoding="utf-8"))
        endpoint = next(
            node
            for node in tree.body
            if isinstance(node, ast.AsyncFunctionDef)
            and node.name == "create_voice_clone_speech"
        )
        endpoint.decorator_list = []

        class HTTPException(Exception):
            def __init__(self, status_code, detail):
                super().__init__(detail)
                self.status_code = status_code
                self.detail = detail

        def temporary_file(**kwargs):
            return tempfile.NamedTemporaryFile(dir=temporary_directory, **kwargs)

        namespace = {
            "File": lambda default: default,
            "Form": lambda default: default,
            "HTTPException": HTTPException,
            "UploadFile": object,
            "Response": lambda **kwargs: SimpleNamespace(**kwargs),
            "model": Mock(),
            "model_type": "base-1.7b",
            "os": SimpleNamespace(unlink=Mock(wraps=os.unlink)),
            "tempfile": SimpleNamespace(NamedTemporaryFile=temporary_file),
            "suppress": suppress,
            "sanitize_text": lambda text: text,
            "audio_to_bytes": Mock(return_value=b"audio"),
            "print": Mock(),
        }
        namespace["model"].generate_voice_clone.return_value = (b"audio", 24000)
        exec(
            compile(
                ast.Module(body=[endpoint], type_ignores=[]),
                str(server_path),
                "exec",
            ),
            namespace,
        )
        return namespace

    def call_endpoint(self, namespace):
        return asyncio.run(
            namespace["create_voice_clone_speech"](
                input="hello",
                reference_audio=SimpleNamespace(
                    read=AsyncMock(return_value=b"reference")
                ),
            )
        )

    def test_successful_clone_removes_reference_audio(self):
        for server_path in self.SERVER_PATHS:
            with (
                self.subTest(server=server_path.parent.name),
                tempfile.TemporaryDirectory() as directory,
            ):
                namespace = self.load_endpoint(server_path, directory)
                response = self.call_endpoint(namespace)

                self.assertEqual(response.content, b"audio")
                self.assertEqual(list(Path(directory).iterdir()), [])
                namespace["print"].assert_not_called()

    def test_failed_generation_removes_reference_audio_and_preserves_error(self):
        for server_path in self.SERVER_PATHS:
            with (
                self.subTest(server=server_path.parent.name),
                tempfile.TemporaryDirectory() as directory,
            ):
                namespace = self.load_endpoint(server_path, directory)
                namespace["model"].get_state_for_audio_prompt.side_effect = (
                    RuntimeError("generation failed")
                )
                namespace["model"].generate_voice_clone.side_effect = RuntimeError(
                    "generation failed"
                )

                with self.assertRaises(namespace["HTTPException"]) as raised:
                    self.call_endpoint(namespace)

                self.assertEqual(raised.exception.status_code, 500)
                self.assertEqual(raised.exception.detail, "generation failed")
                self.assertEqual(list(Path(directory).iterdir()), [])
                namespace["print"].assert_not_called()

    def test_cleanup_failure_is_reported_without_hiding_generation_error(self):
        for server_path in self.SERVER_PATHS:
            with (
                self.subTest(server=server_path.parent.name),
                tempfile.TemporaryDirectory() as directory,
            ):
                namespace = self.load_endpoint(server_path, directory)
                namespace["model"].get_state_for_audio_prompt.side_effect = (
                    RuntimeError("generation failed")
                )
                namespace["model"].generate_voice_clone.side_effect = RuntimeError(
                    "generation failed"
                )
                namespace["os"].unlink.side_effect = PermissionError(
                    "permission denied"
                )

                with self.assertRaises(namespace["HTTPException"]) as raised:
                    self.call_endpoint(namespace)

                self.assertEqual(raised.exception.detail, "generation failed")
                namespace["print"].assert_called_once_with(
                    "Warning: Could not remove temporary reference audio: "
                    "permission denied"
                )

    def test_already_removed_reference_does_not_hide_encoding_error(self):
        for server_path in self.SERVER_PATHS:
            with (
                self.subTest(server=server_path.parent.name),
                tempfile.TemporaryDirectory() as directory,
            ):
                namespace = self.load_endpoint(server_path, directory)
                namespace["audio_to_bytes"].side_effect = ValueError("encoding failed")

                with self.assertRaises(namespace["HTTPException"]) as raised:
                    self.call_endpoint(namespace)

                self.assertEqual(raised.exception.detail, "encoding failed")
                self.assertEqual(list(Path(directory).iterdir()), [])
                namespace["print"].assert_not_called()


class ModelDependencyExitTests(unittest.TestCase):
    def test_missing_models_exit_cleanly_without_site_helpers(self):
        server_paths = (
            SERVER_PATH,
            SERVER_PATH.parents[1] / "qwen-tts-server" / "server.py",
            SERVER_PATH.parents[1] / "kyutai-tts-1.6b-server" / "server.py",
        )
        for server_path in server_paths:
            with self.subTest(server=server_path.parent.name):
                tree = ast.parse(server_path.read_text(encoding="utf-8"))
                import_guard = next(
                    node for node in tree.body if isinstance(node, ast.Try)
                )
                result = subprocess.run(
                    [
                        sys.executable,
                        "-I",
                        "-S",
                        "-c",
                        "import sys\n" + ast.unparse(import_guard),
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )

                self.assertEqual(result.returncode, 1)
                self.assertIn("package not installed", result.stdout)
                self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
