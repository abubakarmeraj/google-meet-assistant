# Google Meet Assistant — personal Natively fork

This project is based on Natively, originally developed by Natively AI Private Limited.

An unofficial personal-use source distribution with local Parakeet transcription,
document RAG, a custom system prompt, SearXNG web search, and readable live transcripts.
It keeps the original Natively license and attribution. It is source-available,
not a separately relicensed open-source product. Private premium code is excluded.

## Install

On Windows x64, download **install.py** from this private repository and run it with Python 3:

```powershell
py install.py
```

It installs missing Node.js, Git, Rust and C++ build tools, clones this private
repository after GitHub sign-in, downloads the speech/document models, builds the
app, starts SearXNG using Docker, and adds **Google Meet Assistant** to Start.
Existing Docker Desktop is reused. Windows may request administrator approval
or a restart for missing prerequisites; rerun the same file after restarting.
Close Natively before installing. Existing settings, keys and documents are kept.
Use `--search wsl` for WSL, `--search none` to skip search, or `--check` to report
prerequisites. See [the installation guide](INSTALL.md) for paths and details.

For a manual source installation after installing the prerequisites:

```powershell
git clone https://github.com/abubakarmeraj/google-meet-assistant.git
cd google-meet-assistant
npm run setup
```

You can also double-click **setup.cmd**. Default Windows setup uses Parakeet TDT
0.6B v3 and SearXNG in WSL, without Docker. To choose Docker instead, run
`npm run setup -- --search docker`. To skip search, use `--search none`.

Start with **start-natively.cmd** or `npm run start:personal`.
Choose your cloud answer provider in **Settings → AI Providers**.

This is an installable source repository, not a signed .exe/.dmg installer.
Dependencies and models are downloaded during setup; no submodules are required.

## Included

| Feature | Location |
| --- | --- |
| Parakeet local speech-to-text | Settings → Audio |
| PDF/DOCX/TXT/Markdown document retrieval | Settings → Knowledge → Documents |
| Answer instructions | Settings → Knowledge → System prompt |
| SearXNG, WSL or Docker, plus optional Tavily | Settings → Knowledge → Web search |
| High-contrast, multiline live transcripts | Meeting overlay |

**[Full installation guide](INSTALL.md)** · **[Knowledge guide](docs/knowledge-workspace.md)** ·
**[Search service guide](local-search/README.md)** · **[Origin and modifications](UPSTREAM.md)**

API keys, account credentials, personal documents, meeting databases, downloaded
models, WSL disks, node_modules and generated builds are excluded from Git.
Questions are sent to your selected search service and its search engines.
Relevant document passages and web snippets go to your selected answer provider.
No local chat model or Gemma installation is required. Cloud answering needs your
own provider credentials or supported account login.

## Validation and limits

`npm run test:setup`, `npm run test:knowledge`, `npm run typecheck:ts7`, and
`npm run typecheck:electron` run the setup, retrieval, transport and type checks.
Windows is physically tested. macOS setup paths are covered by automated checks;
physical macOS installation is not yet verified for this fork.

Calendar OAuth needs your own app configuration. Private Modes/Profile
Intelligence are unavailable. Scanned PDFs need OCR. See the guides for limits.
The original project documentation is preserved in [README.upstream.md](README.upstream.md).

## License

[Natively Personal Use Source License v1.0](LICENSE). Personal/non-commercial use
only under the upstream terms. This is an unofficial modified build, not an
official Natively release. Third-party dependencies and downloaded models retain
their original licenses.
