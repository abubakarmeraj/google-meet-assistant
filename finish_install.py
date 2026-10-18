#!/usr/bin/env python3
r"""Finish Google Meet Assistant setup after the old GitHub login step.

Run: py finish_install.py
Optional: --directory D:\Apps\GoogleMeetAssistant --search docker --no-launch
Uses existing build tools. Does not install prerequisites or ask for GitHub login.
"""
from __future__ import annotations

import ast
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

INSTALLER_URL = "https://raw.githubusercontent.com/abubakarmeraj/google-meet-assistant/main/install.py"
REPOSITORY = "https://github.com/abubakarmeraj/google-meet-assistant.git"
MAX_BYTES = 256 * 1024


def download_installer(target: Path) -> None:
    for attempt in range(3):
        try:
            request = Request(INSTALLER_URL, headers={"User-Agent": "GoogleMeetAssistant-Resume/1", "Accept": "text/plain"})
            with urlopen(request, timeout=30) as response:
                if response.status != 200:
                    raise RuntimeError("Installer download returned HTTP " + str(response.status))
                content = response.read(MAX_BYTES + 1)
            if not content or len(content) > MAX_BYTES:
                raise RuntimeError("Installer download is empty or exceeds the size limit.")
            tree = ast.parse(content.decode("utf-8-sig"), filename="install.py")
            source = next((node.value.value for node in tree.body if isinstance(node, ast.Assign)
                           and any(isinstance(name, ast.Name) and name.id == "REPOSITORY" for name in node.targets)
                           and isinstance(node.value, ast.Constant)), None)
            if source != REPOSITORY:
                raise RuntimeError("Downloaded file is not the expected Google Meet Assistant installer.")
            compile(tree, "install.py", "exec")
            target.write_bytes(content)
            return
        except (OSError, URLError) as error:
            if attempt == 2:
                raise RuntimeError("Could not download the public installer. Check the internet connection and retry. " + str(error)) from error
            print("Download interrupted; retrying...", flush=True)
            time.sleep(attempt + 1)


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    if "--help" in arguments or "-h" in arguments:
        print(__doc__ + "\nOptions: --directory PATH, --search docker|wsl|none, --no-launch, --check, --profile PATH")
        return 0
    if sys.platform != "win32":
        print("This resume script supports Windows. On macOS follow INSTALL.md.")
        return 1
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    print("Finish Google Meet Assistant installation\nCancel the old installer with Ctrl+C first if it is still waiting for GitHub login.\n"
          "Downloading the updated public installer; existing build tools will be reused.", flush=True)
    try:
        with tempfile.TemporaryDirectory(prefix="google-meet-finish-") as temporary:
            installer = Path(temporary) / "install.py"
            download_installer(installer)
            return subprocess.run([sys.executable, str(installer), "--resume", *arguments]).returncode
    except (OSError, RuntimeError, SyntaxError, UnicodeError) as error:
        print("Resume stopped: " + str(error), flush=True)
        return 1
    except KeyboardInterrupt:
        print("\nResume cancelled. Run this file again to continue.", flush=True)
        return 130


if __name__ == "__main__":
    result = main()
    if result and len(sys.argv) == 1 and sys.stdin.isatty():
        input("Press Enter to close...")
    sys.exit(result)
