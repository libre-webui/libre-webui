import ast
import re
import unittest
from pathlib import Path


SERVER_PATH = Path(__file__).with_name("server.py")
HELPER_NAMES = {
    "_remove_emoji",
    "_strip_markdown_links",
    "_strip_parenthetical_stage_directions",
    "sanitize_text",
}
CONSTANT_NAMES = {"EMOJI_CODEPOINT_RANGES"}


def load_sanitizer_namespace():
    """Load pure sanitizer helpers without importing the optional ML stack."""
    tree = ast.parse(
        SERVER_PATH.read_text(encoding="utf-8"),
        filename=str(SERVER_PATH),
    )
    selected_nodes = []

    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in HELPER_NAMES:
            selected_nodes.append(node)
            continue

        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in CONSTANT_NAMES
            for target in node.targets
        ):
            selected_nodes.append(node)

    namespace = {"re": re}
    exec(
        compile(
            ast.Module(body=selected_nodes, type_ignores=[]),
            str(SERVER_PATH),
            "exec",
        ),
        namespace,
    )
    return namespace


class SanitizeTextSecurityTests(unittest.TestCase):
    def setUp(self):
        self.sanitize_text = load_sanitizer_namespace()["sanitize_text"]

    def test_preserves_language_text_while_removing_emoji(self):
        self.assertEqual(
            self.sanitize_text("你好，世界 😀 hello ✨"),
            "你好，世界 hello",
        )
        self.assertEqual(
            self.sanitize_text("日本語, 한국어, Привет, café"),
            "日本語, 한국어, Привет, café",
        )

    def test_replaces_links_and_removes_stage_directions(self):
        self.assertEqual(
            self.sanitize_text(
                "Read [the docs](https://librewebui.org) *(quietly)* now"
            ),
            "Read the docs now",
        )
        self.assertEqual(
            self.sanitize_text("[plain] and [link](https://example.com)"),
            "[plain] and link",
        )

    def test_preserves_unclosed_constructs(self):
        self.assertEqual(
            self.sanitize_text("Keep [unfinished"),
            "Keep [unfinished",
        )
        self.assertEqual(
            self.sanitize_text("Keep (unfinished"),
            "Keep (unfinished",
        )

    def test_large_malformed_markup_does_not_trigger_backtracking(self):
        malformed_link = "[" + ("x" * 150_000) + "](" + ("y" * 150_000)
        malformed_direction = "(" + ("quiet " * 50_000)

        self.assertEqual(self.sanitize_text(malformed_link), malformed_link)
        self.assertEqual(
            self.sanitize_text(malformed_direction),
            malformed_direction.strip(),
        )


if __name__ == "__main__":
    unittest.main()
