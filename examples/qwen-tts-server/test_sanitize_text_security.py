import ast
import re
import unittest
from pathlib import Path


SERVER_PATH = Path(__file__).with_name("server.py")
SANITIZER_NAMES = {
    "_is_emoji_character",
    "_remove_emoji",
    "_strip_markdown_links",
    "_strip_parenthetical_directions",
    "sanitize_text",
}
SANITIZER_ASSIGNMENT_NAMES = {
    "_EMOJI_CODEPOINTS",
    "_EMOJI_CODEPOINT_RANGES",
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
                and target.id in SANITIZER_ASSIGNMENT_NAMES
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
is_emoji_character = SANITIZER["_is_emoji_character"]
remove_emoji = SANITIZER["_remove_emoji"]
strip_markdown_links = SANITIZER["_strip_markdown_links"]
strip_parenthetical_directions = SANITIZER["_strip_parenthetical_directions"]


class SanitizeTextSecurityTests(unittest.TestCase):
    def test_preserves_language_text_while_removing_emoji(self):
        self.assertEqual(sanitize_text("你好，世界 😀 hello ✨"), "你好，世界 hello")
        self.assertEqual(sanitize_text("日本語と 한국어"), "日本語と 한국어")

    def test_emoji_codepoint_boundaries_are_exact(self):
        removed_codepoints = (
            0x24C2,
            0x2600,
            0x27BF,
            0xFE0E,
            0xFE0F,
            0x1F1E0,
            0x1F1FF,
            0x1F201,
            0x1F251,
            0x1F300,
            0x1F6FF,
            0x1F900,
            0x1FAFF,
        )
        preserved_codepoints = (
            0x24C1,
            0x24C3,
            0x25FF,
            0x27C0,
            0xFE0D,
            0xFE10,
            0x1F1DF,
            0x1F200,
            0x1F252,
            0x1F2FF,
            0x1F700,
            0x1F8FF,
            0x1FB00,
        )

        for codepoint in removed_codepoints:
            with self.subTest(codepoint=f"U+{codepoint:04X}", removed=True):
                self.assertTrue(is_emoji_character(chr(codepoint)))

        for codepoint in preserved_codepoints:
            with self.subTest(codepoint=f"U+{codepoint:04X}", removed=False):
                self.assertFalse(is_emoji_character(chr(codepoint)))

    def test_removes_adjacent_and_multi_codepoint_emoji_sequences(self):
        self.assertEqual(
            sanitize_text("before 👨🏽‍💻 🇨🇦 🫶 after"),
            "before after",
        )
        self.assertEqual(sanitize_text("A\uFE0EB\uFE0FC"), "ABC")
        self.assertEqual(
            sanitize_text("alpha😀beta🚀gamma🫶delta"),
            "alphabetagammadelta",
        )

    def test_preserves_non_emoji_multilingual_and_astral_text(self):
        text = "Latin café — 中文𠀀 العربية हिन्दी 日本語 한국어 𝐀 🜀"
        self.assertEqual(sanitize_text(text), text)

    def test_emoji_removal_is_linear_for_large_input(self):
        payload = "ab😀cd🫶" * 50_000
        self.assertEqual(remove_emoji(payload), "abcd" * 50_000)

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
