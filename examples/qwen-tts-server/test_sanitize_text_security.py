import ast
import re
import unittest
from pathlib import Path


SERVER_PATH = Path(__file__).with_name("server.py")
SANITIZER_NAMES = {
    "_strip_markdown_links",
    "_strip_parenthetical_directions",
    "sanitize_text",
}


def load_sanitizer_namespace():
    tree = ast.parse(
        SERVER_PATH.read_text(encoding="utf-8"),
        filename=str(SERVER_PATH),
    )
    sanitizer_nodes = [
        node
        for node in tree.body
        if (
            isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name)
                and target.id == "_EMOJI_PATTERN"
                for target in node.targets
            )
        )
        or (isinstance(node, ast.FunctionDef) and node.name in SANITIZER_NAMES)
    ]
    namespace = {"re": re}
    exec(
        compile(
            ast.Module(body=sanitizer_nodes, type_ignores=[]),
            str(SERVER_PATH),
            "exec",
        ),
        namespace,
    )
    return namespace


SANITIZER = load_sanitizer_namespace()
sanitize_text = SANITIZER["sanitize_text"]
strip_markdown_links = SANITIZER["_strip_markdown_links"]
strip_parenthetical_directions = SANITIZER["_strip_parenthetical_directions"]


class SanitizeTextSecurityTests(unittest.TestCase):
    def test_preserves_language_text_while_removing_emoji(self):
        self.assertEqual(sanitize_text("你好，世界 😀 hello ✨"), "你好，世界 hello")
        self.assertEqual(sanitize_text("日本語と 한국어"), "日本語と 한국어")

    def test_replaces_links_with_labels_and_supports_nested_url_parentheses(self):
        self.assertEqual(
            sanitize_text("See [Libre](https://example.com/a_(b)) now."),
            "See Libre now.",
        )

    def test_removes_balanced_nested_stage_directions(self):
        self.assertEqual(
            sanitize_text("Hello *(whispers (very softly))* world"),
            "Hello world",
        )

    def test_preserves_unclosed_constructs(self):
        self.assertEqual(sanitize_text("Keep [unfinished"), "Keep [unfinished")
        self.assertEqual(sanitize_text("Keep (unfinished"), "Keep (unfinished")

    def test_malformed_markdown_is_processed_without_repeated_rescans(self):
        malformed_link = "[](" * 50_000 + "unfinished"
        malformed_label = "[\\" * 50_000 + "unfinished"
        malformed_direction = "(" * 100_000 + "unfinished"

        self.assertEqual(strip_markdown_links(malformed_link), malformed_link)
        self.assertEqual(strip_markdown_links(malformed_label), malformed_label)
        self.assertEqual(
            strip_parenthetical_directions(malformed_direction),
            malformed_direction,
        )


if __name__ == "__main__":
    unittest.main()
