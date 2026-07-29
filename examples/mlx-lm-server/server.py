#!/usr/bin/env python3
"""
Launch mlx_lm.server with Libre WebUI-friendly local defaults.

The HTTP implementation comes from mlx-lm itself. This wrapper keeps the
server bound to localhost, avoids Libre WebUI's port 8080, and provides a
repeatable command for development.
"""

# /// script
# requires-python = ">=3.10"
# dependencies = ["mlx-lm>=0.31.3"]
# ///

import argparse
import importlib.util
import json
import os
import platform
import shlex
import sys
from collections.abc import Sequence


DEFAULT_MODEL = "prism-ml/Ternary-Bonsai-27B-mlx-2bit"
MAX_CONTEXT_TOKENS = 262_144


def valid_port(value: str) -> int:
    """Parse a TCP port accepted by argparse."""
    port = int(value)
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def valid_max_tokens(value: str) -> int:
    """Parse an output allowance within the default model's context limit."""
    max_tokens = int(value)
    if not 1 <= max_tokens <= MAX_CONTEXT_TOKENS:
        raise argparse.ArgumentTypeError(
            f"max tokens must be between 1 and {MAX_CONTEXT_TOKENS}"
        )
    return max_tokens


def json_object(value: str) -> str:
    """Validate chat-template arguments while preserving a CLI string."""
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise argparse.ArgumentTypeError(
            f"chat template arguments must be valid JSON: {error.msg}"
        ) from error

    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError(
            "chat template arguments must be a JSON object"
        )
    return json.dumps(parsed, separators=(",", ":"))


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Start an OpenAI-compatible MLX LM server for Libre WebUI."
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("MLX_MODEL", DEFAULT_MODEL),
        help="Hugging Face repository ID or local MLX model path.",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("MLX_HOST", "127.0.0.1"),
        help="Bind address. Keep 127.0.0.1 unless another host must connect.",
    )
    parser.add_argument(
        "--port",
        type=valid_port,
        default=valid_port(os.environ.get("MLX_PORT", "8081")),
        help="HTTP port (default: 8081).",
    )
    parser.add_argument(
        "--max-tokens",
        type=valid_max_tokens,
        default=MAX_CONTEXT_TOKENS,
        help=(
            "Default maximum output allowance "
            f"(default: {MAX_CONTEXT_TOKENS}; prompt and output share it)."
        ),
    )
    parser.add_argument(
        "--allowed-origins",
        default="http://localhost:5173,http://127.0.0.1:5173",
        help="Comma-separated browser origins accepted by mlx_lm.server.",
    )
    parser.add_argument(
        "--chat-template-args",
        type=json_object,
        help='JSON object passed to the model chat template, such as \'{"enable_thinking":false}\'.',
    )
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help="Allow tokenizer remote code. Only use for a model repository you trust.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the resolved server command without executing it.",
    )
    return parser.parse_args(argv)


def build_server_command(args: argparse.Namespace) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "mlx_lm.server",
        "--model",
        args.model,
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--max-tokens",
        str(args.max_tokens),
        "--allowed-origins",
        args.allowed_origins,
    ]
    if args.chat_template_args:
        command.extend(["--chat-template-args", args.chat_template_args])
    if args.trust_remote_code:
        command.append("--trust-remote-code")
    return command


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    command = build_server_command(args)

    if args.dry_run:
        print(shlex.join(command))
        return 0

    if platform.system() != "Darwin" or platform.machine() != "arm64":
        print(
            "Warning: this example is intended for Apple Silicon macOS.",
            file=sys.stderr,
        )

    if importlib.util.find_spec("mlx_lm") is None:
        print(
            "mlx-lm is not installed. Run: pip install -r requirements.txt",
            file=sys.stderr,
        )
        return 1

    print(f"Starting MLX LM model: {args.model}")
    print(f"Health: http://{args.host}:{args.port}/health")
    print(f"Models: http://{args.host}:{args.port}/v1/models")
    print(
        "Libre WebUI endpoint: "
        f"http://{args.host}:{args.port}/v1/chat/completions"
    )
    os.execv(sys.executable, command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
