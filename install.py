#!/usr/bin/env python3
r"""Windows bootstrap for the public personal Natively fork. Python stdlib only.

Run: py install.py                         (Docker search; installs missing tools)
     py install.py --check                 (read-only prerequisite report)
     py install.py --search wsl            (alternative search runtime)
     py install.py --resume                (finish app setup; do not install tools)
     py install.py --directory D:\\Apps\\GoogleMeetAssistant --no-launch
This file can run alone or from inside the repository. No keys are bundled.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

REPOSITORY = "https://github.com/abubakarmeraj/google-meet-assistant.git"
MIN_NODE = (22, 13, 0)
REBOOT_CODES = {3010, 1641}


class SetupError(RuntimeError):
    pass


class RestartRequired(SetupError):
    pass


def say(message: str) -> None:
    print(message, flush=True)


def refresh_path() -> None:
    """winget's child installers cannot update this Python process's PATH."""
    import winreg
    paths = [os.environ.get("PATH", "")]
    for hive, key in [
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        (winreg.HKEY_CURRENT_USER, "Environment"),
    ]:
        try:
            with winreg.OpenKey(hive, key) as handle:
                paths.append(os.path.expandvars(winreg.QueryValueEx(handle, "Path")[0]))
        except OSError:
            pass
    program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
    local = Path(os.environ["LOCALAPPDATA"])
    # Also work in the same terminal immediately after a fresh installation.
    paths.extend(str(p) for p in [
        program_files / "nodejs", program_files / "Git/cmd",
        program_files / "Docker/Docker/resources/bin", Path.home() / ".cargo/bin",
        local / "Microsoft/WindowsApps", local / "Microsoft/WinGet/Links",
    ])
    os.environ["PATH"] = os.pathsep.join(dict.fromkeys(
        segment for value in paths for segment in value.split(os.pathsep) if segment
    ))
    os.environ["PYTHON"] = sys.executable
    os.environ["NATIVELY_CORE_SMOKE"] = "1"
    os.environ.pop("ELECTRON_RUN_AS_NODE", None)


def probe(args: list[str], timeout: int = 30) -> str | None:
    try:
        result = subprocess.run(args, capture_output=True, text=True, errors="replace",
                                timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def node_ready() -> bool:
    version = probe(["node", "-p", "process.versions.node"])
    try:
        return tuple(int(p) for p in (version or "").split(".")) >= MIN_NODE
    except ValueError:
        return False


def cpp_ready() -> bool:
    locator = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft Visual Studio/Installer/vswhere.exe"
    install = probe([str(locator), "-latest", "-products", "*", "-requires",
                     "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"])
    # MSVC alone is insufficient for node-gyp: Windows SDK headers are needed.
    kits = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Windows Kits/10/Include"
    return bool(install and any(kits.glob("*/um/Windows.h")))


def rust_ready() -> bool:
    version = probe(["rustc", "-vV"])
    return bool(probe(["cargo", "--version"]) is not None and version
                and "host: x86_64-pc-windows-msvc" in version)


def tools_needed(search: str) -> list[tuple[str, str, str | None]]:
    tools = []
    if not node_ready():
        tools.append(("Node.js LTS", "OpenJS.NodeJS.LTS", None))
    if probe(["git", "--version"]) is None:
        tools.append(("Git for Windows", "Git.Git", None))
    if not cpp_ready():
        tools.append(("Visual Studio 2022 C++ Build Tools and Windows SDK", "Microsoft.VisualStudio.2022.BuildTools",
                      "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"))
    if not rust_ready():
        tools.append(("Rust MSVC toolchain", "Rustlang.Rustup", None))
    if search == "docker" and probe(["docker", "--version"]) is None:
        tools.append(("Docker Desktop", "Docker.DockerDesktop", None))
    return tools


class Runner:
    def __init__(self, log: Path):
        self.log = log

    def run(self, args: list[str], cwd: Path | None = None, interactive: bool = False,
            timeout: int | None = None) -> None:
        say("\n> " + subprocess.list2cmdline([str(a) for a in args]))
        with self.log.open("a", encoding="utf-8") as output:
            output.write("\n> " + subprocess.list2cmdline([str(a) for a in args]) + "\n")
            output.flush()
            if interactive:
                # A tool can explicitly request the actual console.
                result = subprocess.run(args, cwd=cwd, timeout=timeout)
                code = result.returncode
            else:
                with subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      encoding="utf-8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW) as child:
                    try:
                        for line in child.stdout:
                            print(line, end="", flush=True)
                            output.write(line)
                            output.flush()
                        code = child.wait()
                    except BaseException:
                        # Only this installer's child tree; never terminate unrelated tools/apps.
                        subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       creationflags=subprocess.CREATE_NO_WINDOW)
                        raise
        if (code & 0xFFFFFFFF) in REBOOT_CODES:
            raise RestartRequired("A prerequisite needs a Windows restart. Restart, then run this same file again.")
        if code:
            raise SetupError(f"Command failed (exit {code}). See {self.log}. Fix the reported issue and rerun this file.")


def install_tools(runner: Runner, search: str) -> None:
    missing = tools_needed(search)
    if missing and not shutil.which("winget"):
        raise SetupError("Install/update Microsoft's App Installer (winget), then rerun: https://aka.ms/getwinget")
    for label, package, override in missing:
        say("\nInstalling " + label + ". Approve Windows UAC if requested; this can take several minutes.")
        args = ["winget", "install", "--id", package, "--exact", "--source", "winget",
                "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"]
        if override:
            args.extend(["--force", "--override", override])
        else:
            args.append("--silent")
        runner.run(args)
        refresh_path()
        if package == "Rustlang.Rustup":
            runner.run(["rustup", "toolchain", "install", "stable-x86_64-pc-windows-msvc", "--profile", "minimal"])
            runner.run(["rustup", "default", "stable-x86_64-pc-windows-msvc"])
    remaining = tools_needed(search)
    if remaining:
        raise SetupError("Tools are still unavailable: " + ", ".join(t[0] for t in remaining)
                         + ". Restart Windows if requested by their installers, then rerun.")
    require_search_runtime(search)


def require_search_runtime(search: str) -> None:
    if search == "wsl" and probe(["wsl.exe", "--status"]) is None:
        raise SetupError("Enable WSL 2 once from an administrator terminal: wsl --install --no-distribution\n"
                         "Restart Windows, then rerun with --search wsl. Docker mode does not require this step.")


def resume_tools(search: str) -> None:
    missing = tools_needed(search)
    if missing:
        raise SetupError("Resume only installs the app. Missing prerequisites: " + ", ".join(t[0] for t in missing)
                         + ". Run the updated install.py without --resume to install them.")
    require_search_runtime(search)
    say("Reusing installed prerequisites. No WinGet or GitHub sign-in step will run.")


def is_source(folder: Path) -> bool:
    try:
        return (folder / "scripts/setup-personal.mjs").is_file() and json.loads(
            (folder / "package.json").read_text(encoding="utf-8"))["name"] == "natively"
    except (OSError, ValueError, KeyError):
        return False


def destination(value: str | None, script: Path, local: Path) -> Path:
    if value:
        folder = Path(value).expanduser()
        if not folder.is_absolute():
            raise SetupError("--directory must be an absolute path.")
        return folder.resolve()
    if is_source(script.parent):
        return script.parent.resolve()
    return (local / "Programs/GoogleMeetAssistant").resolve()


def checkout(runner: Runner, folder: Path) -> None:
    if is_source(folder):
        say("Using source at " + str(folder) + ". Existing source changes are kept.")
        return
    if folder.exists() and (not folder.is_dir() or any(folder.iterdir())):
        raise SetupError("Destination is not an empty directory or this app's source: " + str(folder))
    folder.parent.mkdir(parents=True, exist_ok=True)
    # Public read access needs no account. Disable credential helpers and prompts
    # for this child only, including Git Credential Manager's browser flow.
    overrides = {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never", "GIT_ASKPASS": "", "SSH_ASKPASS": ""}
    previous = {key: os.environ.get(key) for key in overrides}
    os.environ.update(overrides)
    try:
        runner.run(["git", "-c", "credential.helper=", "-c", "core.askPass=", "-c", "credential.interactive=false",
                    "clone", "--depth", "1", REPOSITORY, str(folder)])
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    if not is_source(folder):
        raise SetupError("Repository clone is incomplete. See the log before retrying.")


def shortcut(runner: Runner, folder: Path, node: str) -> None:
    # WScript keeps the console hidden. Node launches Electron with detached
    # stdout handling, avoiding broken pipes when the installer window closes.
    command = subprocess.list2cmdline([node, str(folder / "scripts/start-personal.mjs")])
    launcher = folder / ".personal-launch.vbs"
    launcher.write_text('CreateObject("WScript.Shell").Run "' + command.replace('"', '""') + '", 0, False\r\n', encoding="utf-16")
    os.environ["NATIVELY_SHORTCUT_SOURCE"] = str(launcher)
    os.environ["NATIVELY_SHORTCUT_ROOT"] = str(folder)
    try:
        runner.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                    "$link = Join-Path ([Environment]::GetFolderPath('Programs')) 'Google Meet Assistant.lnk'; "
                    "$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link); "
                    "$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\\wscript.exe'; "
                    "$shortcut.Arguments = '\"' + $env:NATIVELY_SHORTCUT_SOURCE + '\"'; "
                    "$shortcut.WorkingDirectory = $env:NATIVELY_SHORTCUT_ROOT; "
                    "$shortcut.IconLocation = Join-Path $env:NATIVELY_SHORTCUT_ROOT 'node_modules\\electron\\dist\\electron.exe'; "
                    "$shortcut.Save()"])
    finally:
        os.environ.pop("NATIVELY_SHORTCUT_SOURCE", None)
        os.environ.pop("NATIVELY_SHORTCUT_ROOT", None)


def launch(folder: Path, node: str, log: Path) -> None:
    # Use real file handles, not pipes whose owner disappears on installer exit.
    with log.open("a", encoding="utf-8") as output:
        subprocess.Popen([node, str(folder / "scripts/start-personal.mjs")], cwd=folder,
                         stdin=subprocess.DEVNULL, stdout=output, stderr=output, close_fds=True,
                         creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP)


@contextlib.contextmanager
def install_lock(file: Path):
    import msvcrt
    with file.open("a+b") as handle:
        if file.stat().st_size == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise SetupError("Another copy of this installer is running. Close it before retrying.") from error
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--directory", help="Absolute install directory; defaults to this checkout or LocalAppData/Programs/GoogleMeetAssistant")
    parser.add_argument("--search", choices=["docker", "wsl", "none"], default="docker")
    parser.add_argument("--check", action="store_true", help="Report prerequisites without installing or signing in")
    parser.add_argument("--resume", action="store_true", help="Skip prerequisite installation and finish app download/build/setup")
    parser.add_argument("--no-launch", action="store_true", help="Do not open the app after installation")
    parser.add_argument("--profile", help="Absolute separate test profile (does not create a normal-profile shortcut)")
    args = parser.parse_args(argv)
    if sys.platform != "win32" or platform.machine().lower() not in {"amd64", "x86_64"}:
        say("This Python bootstrap supports Windows x64. On macOS follow INSTALL.md (npm run setup -- --search docker or none).")
        return 1
    if args.profile and not Path(args.profile).is_absolute():
        say("--profile must be an absolute path.")
        return 1
    local = Path(os.environ["LOCALAPPDATA"])
    refresh_path()
    folder = destination(args.directory, Path(__file__).resolve(), local)
    if folder.exists() and not is_source(folder) and (not folder.is_dir() or any(folder.iterdir())):
        raise SetupError("Choose an empty install directory; no existing files will be overwritten: " + str(folder))
    missing = tools_needed(args.search)
    say("Google Meet Assistant personal installer\nSource: " + REPOSITORY + "\nInstall directory: " + str(folder)
        + "\nSearch: " + args.search + "\nPython: " + sys.executable)
    if args.check:
        for label, _, _ in missing:
            say("Missing: " + label)
        if args.search == "wsl" and probe(["wsl.exe", "--status"]) is None:
            say("Missing: WSL 2 (enable it and restart before --search wsl)")
            return 1
        say("Prerequisites ready." if not missing else "Run install.py without --check or --resume to install missing tools.")
        return int(bool(missing))
    logs = local / "GoogleMeetAssistant/setup"
    logs.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    log = logs / ("install-" + stamp + ".log")
    say("Log: " + str(log) + "\nClose Natively before proceeding. Existing settings, keys and documents will be kept.")
    try:
        with install_lock(logs / "installer.lock"):
            runner = Runner(log)
            if args.resume:
                resume_tools(args.search)
            else:
                install_tools(runner, args.search)
            checkout(runner, folder)
            node = shutil.which("node")
            setup = [node, str(folder / "scripts/setup-personal.mjs"), "--search", args.search]
            if args.profile:
                setup.extend(["--profile", args.profile])
            runner.run(setup, cwd=folder)
            if args.search != "none":
                runner.run([node, str(folder / "local-search/manage.mjs"), args.search, "test"], cwd=folder)
            if not args.profile:
                shortcut(runner, folder, node)
                if not args.no_launch:
                    launch(folder, node, logs / "app-launch.log")
        say("\nInstalled successfully. Open Google Meet Assistant from the Start menu.\n"
            "Choose your cloud account/key in Settings > AI Providers. Documents and system prompt: Settings > Knowledge.\n"
            "No local chat model is installed. Parakeet handles speech; small local models handle document retrieval.")
        if args.profile:
            say("Separate test profile configured; normal app was not launched or added to Start.")
        return 0
    except RestartRequired as error:
        say("\n" + str(error))
        return 3010
    except (SetupError, OSError) as error:
        say("\nSetup stopped: " + str(error) + "\nRerun this file after resolving the issue. Log: " + str(log))
        return 1
    except KeyboardInterrupt:
        say("\nSetup cancelled. Run the file again to retry. Log: " + str(log))
        return 130


if __name__ == "__main__":
    # Keep double-click errors visible while preserving command-line automation.
    try:
        exit_code = main()
    except (SetupError, OSError) as error:
        say("Setup stopped: " + str(error))
        exit_code = 1
    if exit_code and len(sys.argv) == 1 and sys.stdin.isatty():
        input("Press Enter to close...")
    sys.exit(exit_code)
