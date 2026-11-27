#!/usr/bin/env python3
"""
Serve an MLX model to Libre WebUI from an Apple Silicon Mac.

The default model, Ternary Bonsai 2.5 27B, is a Prism ML pack. Its weights are
stored in a rotated basis that only the pack's own loader undoes, so stock
mlx-lm cannot read them. For a pack, this script runs mlx-vlm's
OpenAI-compatible server in this process with the pack loader installed and
the server held to that one model. Any other model goes to the official
mlx_lm.server unchanged.
"""

# /// script
# requires-python = ">=3.10,<3.15"
# dependencies = [
#   "mlx==0.32.0",
#   "mlx-lm==0.31.3",
#   "mlx-vlm==0.6.3",
#   "transformers==5.10.4",
#   "numpy>=2.0",
#   "tokenizers>=0.21",
#   "jinja2>=3.1.6",
#   "pillow>=13.0.0",
# ]
# ///

import argparse
import importlib
import importlib.util
import json
import os
import platform
import shlex
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path


DEFAULT_MODEL = "prism-ml/Ternary-Bonsai-2.5-27B-mlx-2bit"
# The pack loader is Python that ships inside the model repository. This is the
# revision whose runtime/ directory was reviewed for this example; a newer
# upload is not run until the pin moves.
DEFAULT_MODEL_REVISION = "aa432fd0e17612f6684e728d4d3c42b6656bcabb"
PACK_MODEL_TYPE = "prism_hadamard_qwen35"
# The pack loader reaches into mlx-vlm internals, and so does this script.
PACK_MLX_VLM_VERSION = "0.6.3"
MAX_CONTEXT_TOKENS = 262_144
PACK_RUNTIME = "bonsai-pack"
MLX_LM_RUNTIME = "mlx-lm"


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
        description="Start an OpenAI-compatible MLX server for Libre WebUI."
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("MLX_MODEL", DEFAULT_MODEL),
        help="Hugging Face repository ID or local MLX model path.",
    )
    parser.add_argument(
        "--revision",
        help=(
            "Hugging Face revision of the Bonsai pack. Defaults to the reviewed "
            "pin; any other revision needs --trust-remote-code."
        ),
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
        help="Comma-separated browser origins the server accepts.",
    )
    parser.add_argument(
        "--chat-template-args",
        type=json_object,
        help=(
            "JSON object passed to the model chat template, such as "
            '\'{"enable_thinking":false}\'. A Bonsai pack takes only '
            "enable_thinking, as the default for requests that do not set it."
        ),
    )
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help=(
            "Run code that ships with the model: tokenizer code for mlx_lm.server, "
            "or the loader of a Bonsai pack other than the reviewed default. "
            "Only use for a model repository you trust."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print how the server would start without loading a model.",
    )
    return parser.parse_args(argv)


def read_json_file(path: Path) -> dict:
    try:
        parsed = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def is_pack_directory(model: str) -> bool:
    """Whether `model` names a local directory holding a Prism ML pack."""
    directory = Path(model).expanduser()
    return (
        directory.is_dir()
        and read_json_file(directory / "config.json").get("model_type")
        == PACK_MODEL_TYPE
    )


@dataclass(frozen=True)
class Launch:
    runtime: str
    # mlx_lm.server: the full command. Bonsai pack: mlx_vlm.server arguments.
    command: list[str]
    revision: str | None = None


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


def pack_thinking_default(args: argparse.Namespace) -> bool:
    """The pack's chat template thinks unless told otherwise; so does the server."""
    template_args = json.loads(args.chat_template_args or "{}")
    unsupported = sorted(set(template_args) - {"enable_thinking"})
    if unsupported:
        raise ValueError(
            "A Bonsai pack takes only enable_thinking in --chat-template-args; "
            f"remove {', '.join(unsupported)}."
        )
    return template_args.get("enable_thinking", True) is not False


def build_pack_server_arguments(args: argparse.Namespace) -> list[str]:
    arguments = [
        "--model",
        args.model,
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--max-tokens",
        str(args.max_tokens),
    ]
    if pack_thinking_default(args):
        arguments.append("--enable-thinking")
    return arguments


def resolve_launch(args: argparse.Namespace) -> Launch:
    if args.model == DEFAULT_MODEL:
        revision = args.revision or DEFAULT_MODEL_REVISION
        if revision != DEFAULT_MODEL_REVISION and not args.trust_remote_code:
            raise ValueError(
                f"Revision {revision} of {DEFAULT_MODEL} has not been reviewed. "
                "Its loader runs as Python on this Mac; pass --trust-remote-code "
                "to run it anyway."
            )
        return Launch(PACK_RUNTIME, build_pack_server_arguments(args), revision)

    if is_pack_directory(args.model):
        if not args.trust_remote_code:
            raise ValueError(
                f"{args.model} is a Bonsai pack. Its loader in runtime/ runs as "
                "Python on this Mac; pass --trust-remote-code to run it."
            )
        return Launch(PACK_RUNTIME, build_pack_server_arguments(args))

    if args.revision:
        raise ValueError("--revision applies only to the Bonsai pack.")
    return Launch(MLX_LM_RUNTIME, build_server_command(args))


def pack_sampling_defaults(pack: Path) -> dict:
    """The sampler a pack ships in generation_config.json.

    mlx-vlm reads request defaults from the model config, not from that file,
    so the loader copies them across.
    """
    generation = read_json_file(pack / "generation_config.json")
    defaults = {
        key: generation[key]
        for key in ("temperature", "top_p", "top_k")
        if isinstance(generation.get(key), (int, float))
        and not isinstance(generation.get(key), bool)
    }
    if generation.get("do_sample") is False:
        defaults["temperature"] = 0.0
    return defaults


def rejected_model_request(
    served: str,
    model_path: str | None,
    adapter_path: object,
    model_kind: str,
    inherit_adapter: object,
) -> str | None:
    """Why a request may not load a model, or None when it asks for the served one.

    mlx-vlm loads whatever model or adapter a request names. Here every request
    runs on the one pack this script started with, so nothing a request sends
    can make the server download or run other code.
    """
    if model_path != served:
        return f"This server serves only {served}; requested {model_path!r}."
    if model_kind != "auto":
        return f"{served} is a chat model; {model_kind} is not available."
    if adapter_path is not inherit_adapter and adapter_path is not None:
        return "Adapters are not available on this server."
    return None


def load_pack(pack: Path):
    """Load a vision-capable pack with its own loader and make it look stock.

    The pack names itself prism_hadamard_qwen35. mlx-vlm formats prompts and
    picks parsers by model type, so the loaded config carries the base type.
    """
    runtime_dir = str(pack / "runtime")
    if runtime_dir not in sys.path:
        sys.path.insert(0, runtime_dir)
    from vision_artifact import load_vl_model

    model, processor, pack_config = load_vl_model(pack)
    config = model.config
    config.model_type = pack_config["base_model_type"]
    for key, value in pack_sampling_defaults(pack).items():
        setattr(config, key, value)
    return model, processor, config


def download_pack(model: str, revision: str) -> Path:
    from huggingface_hub import snapshot_download

    print(f"Fetching {model} at {revision[:12]} (about 8.6 GB the first time)")
    # The optional MTP draft head is left out: the server does not use it.
    return Path(
        snapshot_download(model, revision=revision, ignore_patterns=["mtp/*"])
    )


def serve_pack(args: argparse.Namespace, launch: Launch) -> int:
    from mlx_vlm.version import __version__ as mlx_vlm_version

    if mlx_vlm_version != PACK_MLX_VLM_VERSION:
        print(
            f"The Bonsai pack needs mlx-vlm {PACK_MLX_VLM_VERSION}; found "
            f"{mlx_vlm_version}. Run: pip install -r requirements.txt",
            file=sys.stderr,
        )
        return 1

    if launch.revision:
        pack = download_pack(args.model, launch.revision)
    else:
        pack = Path(args.model).expanduser().resolve()
    if not read_json_file(pack / "config.json").get("components", {}).get("vision"):
        print(
            "This launcher serves Bonsai packs that include the vision tower.",
            file=sys.stderr,
        )
        return 1

    import mlx_vlm.server as server
    from fastapi import HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from mlx_vlm.server import cli, generation

    # The package copies the submodule's names over it, so `server.app` is the
    # FastAPI instance and the submodule has to be fetched by its full name.
    app_module = importlib.import_module("mlx_vlm.server.app")

    served = args.model
    inherit_adapter = app_module._INHERIT_ADAPTER
    load_cached_model = app_module.get_cached_model

    def load_model_resources(model_path, adapter_path):
        reason = rejected_model_request(
            served, model_path, adapter_path, "auto", inherit_adapter
        )
        if reason:
            raise HTTPException(status_code=404, detail=reason)
        return load_pack(pack)

    def get_cached_model(model_path, adapter_path=inherit_adapter, *, model_kind="auto"):
        reason = rejected_model_request(
            served, model_path, adapter_path, model_kind, inherit_adapter
        )
        if reason:
            raise HTTPException(status_code=404, detail=reason)
        return load_cached_model(served, None, model_kind="auto")

    import mlx.core as mx

    prepare_request = generation.ResponseGenerator._cpu_preprocess

    def prepare_request_on_this_thread(self, *args, **kwargs):
        # Image requests come back with lazy arrays (the attention mask) built on
        # the request thread. MLX 0.32 keeps GPU streams per thread, so the
        # generation thread cannot evaluate them and dies, hanging the server.
        # Evaluating them where they were built leaves plain data to hand over.
        inputs = prepare_request(self, *args, **kwargs)
        arrays = []
        for value in inputs.values():
            values = value if isinstance(value, (list, tuple)) else [value]
            arrays.extend(item for item in values if isinstance(item, mx.array))
        mx.eval(arrays)
        return inputs

    generation.ResponseGenerator._cpu_preprocess = prepare_request_on_this_thread
    generation.load_model_resources = load_model_resources
    # The request handlers look these up on the package at call time.
    server.get_cached_model = get_cached_model
    # /v1/models lists every MLX model in the Hugging Face cache; list only
    # the one this server runs.
    server.scan_cache_dir = lambda: type("EmptyCache", (), {"repos": []})()

    # mlx-vlm answers every browser origin. Keep the same origins mlx_lm.server
    # gets here; Libre WebUI's backend calls the server directly and needs none.
    app = server.app
    app.user_middleware = [
        middleware
        for middleware in app.user_middleware
        if middleware.cls is not CORSMiddleware
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            origin.strip()
            for origin in args.allowed_origins.split(",")
            if origin.strip()
        ],
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    sys.argv = ["mlx_vlm.server", *launch.command]
    cli.main()
    return 0


def describe(launch: Launch, args: argparse.Namespace) -> str:
    if launch.runtime == MLX_LM_RUNTIME:
        return shlex.join(launch.command)
    source = f"{args.model}@{launch.revision}" if launch.revision else args.model
    return (
        f"Bonsai pack {source} with its own loader on mlx-vlm "
        f"{PACK_MLX_VLM_VERSION}:\nmlx_vlm.server {shlex.join(launch.command)}"
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        launch = resolve_launch(args)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2

    if args.dry_run:
        print(describe(launch, args))
        return 0

    if platform.system() != "Darwin" or platform.machine() != "arm64":
        print(
            "Warning: this example is intended for Apple Silicon macOS.",
            file=sys.stderr,
        )

    required = "mlx_vlm" if launch.runtime == PACK_RUNTIME else "mlx_lm"
    if importlib.util.find_spec(required) is None:
        print(
            f"{required.replace('_', '-')} is not installed. "
            "Run: pip install -r requirements.txt",
            file=sys.stderr,
        )
        return 1

    print(f"Starting MLX model: {args.model}")
    print(f"Health: http://{args.host}:{args.port}/health")
    print(f"Models: http://{args.host}:{args.port}/v1/models")
    print(
        "Libre WebUI endpoint: "
        f"http://{args.host}:{args.port}/v1/chat/completions"
    )
    if launch.runtime == PACK_RUNTIME:
        return serve_pack(args, launch)
    os.execv(sys.executable, launch.command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
