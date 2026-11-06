"""Start the Blender MCP socket listener for blender-mcp (blmcp) clients.

Blender's `mcp` extension only binds the socket in `start()`; in background mode
(`blender -b`) nothing pumps it, so this script runs the required poll loop.
Without the pump the port accepts connections but every request times out.

Usage:
    blender -b --python scripts/blender-mcp-listener.py [-- --port 9876]

The listener runs until the process is killed.
"""

from __future__ import annotations

import argparse
import sys

import addon_utils
import bpy  # noqa: F401  (imported for the extension's runtime context)


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=9876)
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    addon_utils.enable("bl_ext.user_default.mcp", default_set=True)
    from bl_ext.user_default.mcp import mcp_to_blender_server as server

    server.start(args.host, args.port)
    print(f"blender-mcp listener ready on {args.host}:{args.port}", flush=True)
    while True:
        server.poll_blocking(0.5)


if __name__ == "__main__":
    main()
