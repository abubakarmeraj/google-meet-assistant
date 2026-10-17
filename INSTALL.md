# Install the personal Google Meet assistant

This project is based on Natively, originally developed by Natively AI Private Limited.
This is an unofficial personal-use source distribution. The original [LICENSE](LICENSE)
applies. Private premium code is not included or needed by this setup.

## Windows 10/11 x64

### Python installer (recommended for the other laptop)

Install Python 3 first if it is missing. Download **install.py** using GitHub's
download-file button while signed into this private repository, then run:

```powershell
py install.py
```

Only this Python file is needed to start. It uses Python's standard library and
Microsoft WinGet to install missing Node.js LTS, Git, Rust (MSVC), Visual Studio
2022 C++ Build Tools/Windows SDK and GitHub CLI. The C++ workload can be a large
download. It reuses an existing Docker Desktop installation; if missing, it
installs Docker Desktop. Start Docker Desktop and complete its first-run prompts
if requested. Required Windows features/hardware virtualization must be available
for Docker's Linux engine. A prerequisite may require UAC approval or a restart;
the installer never restarts Windows automatically. Rerun it after a restart.

For a standalone file, it clones this private repository to
`%LOCALAPPDATA%\Programs\GoogleMeetAssistant`. GitHub sign-in is required once,
using an account with access to this private repository. No access tokens or API
keys are included. If run inside a checkout, it installs that checkout instead.
Existing source files are kept; the installer does not pull over your changes.

Docker search is the Python installer's default. It builds the app, downloads
Parakeet and the small retrieval models, configures SearXNG, tests a real search,
creates a Start menu shortcut and opens the app. First installation takes several
minutes and several GB; missing build tools can take longer. This is an automated
source build, rather than a signed binary installer. On another laptop, sign into
your answer provider again; Windows-encrypted credentials are machine-specific.

The prerequisite installer uses Microsoft's documented [WinGet install options](https://learn.microsoft.com/en-us/windows/package-manager/winget/install)
and [Visual Studio workload arguments](https://learn.microsoft.com/en-us/visualstudio/install/use-command-line-parameters-to-install-visual-studio).

```powershell
py install.py --check
py install.py --directory D:\Apps\GoogleMeetAssistant
py install.py --search wsl
py install.py --search none --no-launch
```

WSL mode requires WSL 2 enabled first (`wsl --install --no-distribution` in an
administrator terminal, then restart). It uses the same dedicated distribution
as the manual installer. Docker mode does not install this separate WSL distro.
Logs: `%LOCALAPPDATA%\GoogleMeetAssistant\setup`. Rerun on failure; model downloads
resume and verify checksums. Settings, keys and uploaded documents remain in
`%APPDATA%\natively`. Setup refuses to change an unreadable credential store.
`--profile C:\absolute\test-profile --no-launch` configures a separate profile
without adding a shortcut or opening the normal app.

### Manual source installation

Install these prerequisites once:

- Node.js 22.13 or newer, including npm (tested with Node 24).
- Git for Windows.
- Python 3, accessible through `py` or `python` (required by node-gyp).
- Rust via rustup, with the MSVC toolchain.
- Visual Studio 2022 Build Tools: **Desktop development with C++**, MSVC x64/x86
  tools and a Windows SDK.
- For WSL search: WSL 2 enabled. If needed, run `wsl --install --no-distribution`
  from an administrator terminal and restart Windows.
- For Docker search: Docker Desktop with Linux containers.

Close any running Natively instance before setup configures its profile. Clone
this repository normally; **do not** use `--recurse-submodules`.

```powershell
git clone https://github.com/abubakarmeraj/google-meet-assistant.git
cd google-meet-assistant
npm run setup
```

Or double-click **setup.cmd** after cloning/downloading and installing the
prerequisites. The default Windows setup:

1. Installs locked npm dependencies and rebuilds native Electron dependencies.
2. Compiles the Rust audio module and builds the renderer and Electron backend.
3. Downloads and verifies Parakeet TDT 0.6B v3 INT8 (about 640 MiB).
4. Installs SearXNG into the dedicated **Natively-SearXNG** WSL distribution.
5. Selects local Parakeet transcription and SearXNG for current-information queries.

Internet is required for package/model downloads and web search. Disk usage is
several GB, including build tools and runtime packages. Setup can take several
minutes. No local chat model, Gemma, or Ollama is installed. The small document
embedding, reranking and turn-detection models are downloaded by npm postinstall.

To use Docker search instead:

```powershell
npm run setup -- --search docker
```

To install just the desktop app and Parakeet:

```powershell
npm run setup -- --search none
```

To check prerequisites without installing anything:

```powershell
npm run setup -- --check
```

## Start and configure

Double-click **start-natively.cmd** or run:

```powershell
npm run start:personal
```

The launcher starts the selected local search service and opens the built app.
If a service cannot start, the desktop app still opens and search reports the
problem. It never switches to a paid search provider automatically.

- **Settings → AI Providers:** connect your answer provider or Codex CLI account.
  Your own cloud API key/account is required for cloud-generated answers; no keys
  or accounts come with the repository.
- **Settings → Audio:** Parakeet is selected by the default setup. To use cloud
  speech instead, choose a cloud provider and supply its credentials.
- **Settings → Knowledge → Documents:** upload PDF, DOCX, TXT and Markdown.
- **Settings → Knowledge → System prompt:** save answer instructions.
- **Settings → Knowledge → Web search:** select SearXNG on WSL (8889) or Docker
  (8888), save changes and test a question. No SearXNG API key is needed.

The original Google/Microsoft calendar integrations need your own OAuth app
configuration. Private premium features remain unavailable.

## macOS

Install Node, Git, Python 3, Rust and Xcode command-line tools (`xcode-select --install`).
Clone the same repository and run `npm run setup -- --search none` or
`npm run setup -- --search docker` with Docker Desktop installed. WSL is a Windows
option. The shared setup/launcher passes arguments without shell interpolation.
This consolidation was physically installed/tested on Windows; macOS has not
been physically validated for this fork.

## Reinstall, storage and development

Settings and documents use the existing Natively user profile. Setup backs up
existing settings, credentials and library metadata before configuration and
loads the encrypted credential store before changing speech settings. Existing
AI keys and uploaded documents are preserved. `.env` is created only when absent,
with Ollama disabled; enter credentials in the app rather than committing them.

Parakeet downloads into the profile's `whisper-models` directory (or its existing
junction). On the original Windows machine this junction points into
`D:\new-projects\google-meet\models\speech`. New installs use normal per-user
application storage. Model files are fetched from a pinned Hugging Face revision
and checked by size and SHA-256; they are not stored in Git. Interrupted model
downloads retry in bounded chunks and resume when setup is run again.

For a separate test profile, use `--profile` with an absolute directory.
`--no-speech` skips Parakeet download/configuration, `--skip-dependencies` reuses
an already installed node_modules, and `--no-configure` skips profile settings
changes. Keep runtime profiles outside source control.

```powershell
npm run test:setup
npm run test:knowledge
npm run typecheck:ts7
npm run typecheck:electron
```

Source installation is supplied here; this repository does not claim to provide
a signed Windows/macOS installer. For source development, use the public build
with `NATIVELY_CORE_SMOKE=1` as the setup script does. Do not fetch the original
private submodule. See [Knowledge guide](docs/knowledge-workspace.md) and
[local search operations](local-search/README.md).
