import ast
import re
import unittest
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
