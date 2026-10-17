# SearXNG for Natively

Open **Settings → Knowledge → Web search**, choose **SearXNG**, choose the
**Docker · 8888** or **WSL · 8889** preset, set when to search, and click
**Save changes**. The test box runs a real search even when automatic search is
off. No SearXNG API key is needed. Tavily remains a separate optional provider.

| Option | App URL | Requirements |
| --- | --- | --- |
| Docker | `http://127.0.0.1:8888` | Docker Desktop running Linux containers |
| WSL | `http://127.0.0.1:8889` | Windows, WSL 2, dedicated Ubuntu distribution |

Launchers and configuration live in
`D:\new-projects\google-meet\local-search`. The WSL virtual disk is in
`runtime/wsl`; Docker images use Docker Desktop's existing storage.
WSL runs Python and Waitress directly;
it does **not** use Docker. You only need one instance running for normal use.
The local `start-natively.cmd` launcher starts the selected local service when
Knowledge and automatic web search are enabled. To start the other instance,
double-click `start-docker.cmd` or `start-wsl.cmd` in this directory, then switch
the preset in Settings. The preset changes the URL; it does not start a service.

## Commands

Run these from the repository root. Replace `wsl` with `docker` for Docker:

```powershell
node local-search/manage.mjs wsl install
node local-search/manage.mjs wsl start
node local-search/manage.mjs wsl test
node local-search/manage.mjs wsl status
node local-search/manage.mjs wsl stop
```

`npm run search:wsl -- start` and `npm run search:docker -- start` also work.
Only run `install` for initial installation or to reapply configuration.
The WSL installer creates **Natively-SearXNG** in `local-search/runtime/wsl`.
It does not change the default distro or modify other distros. Existing WSL
must already be enabled; a fresh machine may need an administrator to enable it
and restart Windows before installation. The installer pins the official source
to `2a6fc07be3760543c7b6d1d1bfe62f5765d5d9d6` and runs an unprivileged systemd
service. A hidden WSL session keeps the distro awake while search is running.

Docker uses the official image pinned by digest in `compose.yml`. Port 8888 is
published only on Windows localhost; the existing bridge network avoids changing
Docker's global network configuration. Docker Desktop starts automatically when
using the Docker launcher on this Windows installation. On macOS/Linux, start
Docker first and use the same Node command; WSL launchers are Windows only.
Only Windows has been physically tested here.

## Engines and configuration

Generated configuration is `config/settings.yml`. It has a random secret,
JSON search enabled, and is ignored by Git. Runtime downloads, virtual disks,
Python packages and Docker cache are also ignored.

**DuckDuckGo is enabled by default.** Live checks on this network found Google
and Brave blocked, and Bing returned unrelated results for the test query.
To add engines, edit `use_default_settings.engines.keep_only` and the `engines`
section in the generated file, then test results for your own questions.
For Docker, run `docker compose -f local-search/compose.yml restart`.
For WSL, rerun `node local-search/manage.mjs wsl install` to copy configuration
and restart the service. The example file is used only when generating a new
configuration; existing configuration is preserved.

SearXNG still needs internet access and search engines can rate-limit requests.
Natively shows unavailable-engine and connection warnings. It does not silently
switch to Tavily or another service. Search has a 10-second deadline, at most
four excerpts, a 2 MB response limit, and a five-minute in-memory cache separated
by provider and instance URL. Results are snippets, not full-page crawling.

## Privacy and troubleshooting

Only the current question is sent to SearXNG. It sends those search terms to
the enabled search engines. Matching document passages, web snippets and source
URLs accompany the answer request to your selected AI provider. Source text is
treated as untrusted evidence. Uploaded files and assembled meeting context are
not sent to SearXNG. No Tavily key is sent to the SearXNG URL.

- Connection refused: start the selected service; check its `status` command.
- HTTP 403: enable `json` in `search.formats` on your instance.
- No useful results: test an engine or query directly; check upstream blocking.
- Docker logs: `docker compose -f local-search/compose.yml logs --tail 40`.
- WSL logs: `wsl -d Natively-SearXNG -u root -- journalctl -u natively-searxng --no-pager -n 40`.
- To free WSL memory after stopping search, terminate only this distribution:
  `wsl --terminate Natively-SearXNG`. Do not shut down other WSL distributions.

Official references: [Search API](https://docs.searxng.org/dev/search_api.html),
[Docker installation](https://docs.searxng.org/admin/installation-docker.html),
[Python installation](https://docs.searxng.org/admin/installation-searxng.html).
