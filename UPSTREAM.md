# Origin and attribution

This project is based on Natively, originally developed by Natively AI Private Limited.

- Upstream: https://github.com/Natively-AI-assistant/natively-cluely-ai-assistant
- Source snapshot: `16cfd31` (Natively 2.9.2, checked out on 2026-10-17).
- License: Natively Personal Use Source License v1.0. Natively is source-available;
  this fork does not relicense it as open-source software.
- The original README is preserved as `README.upstream.md` in the consolidated
  distribution. Original source notices and build provenance code are retained.

This unofficial personal-use derivative adds a Knowledge workspace, document RAG,
answer preferences, SearXNG providers for WSL and Docker, a verified Parakeet setup,
readable transcripts, and a repeatable source installer. It is not an official
Natively release and does not include or unlock private premium functionality.

The source distribution uses a single repository. The upstream private `premium`
and optional `natively-api` submodule pointers are omitted; no backend submodule
is required to run the local app with your own AI provider credentials.

Downloaded third-party components retain their own licenses. SearXNG is fetched
from its official repository/image; its AGPL license remains in that distribution.
The Parakeet ONNX export is downloaded from `istupakov/parakeet-tdt-0.6b-v3-onnx`
at revision `8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce`; see its model card and the
upstream NVIDIA Parakeet model card for model license and attribution. npm and
Cargo dependencies retain their individual licenses and lockfiles.
