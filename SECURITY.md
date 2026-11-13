# Security Policy

## Supported versions

Security reports are accepted for the latest release published from this repository.

## Reporting a vulnerability

Use GitHub's **Private vulnerability reporting** feature for anything sensitive. Do not place exploit details, credentials, personal data, or private repository contents in a public issue.

For non-sensitive bugs, open a normal GitHub issue with reproduction steps, expected behavior, actual behavior, environment details, and sanitized evidence.

## Boundaries

- This project is a local-first tool, not a production service.
- Keep all tests on data and systems you own or are authorized to inspect.
- Do not upload live credentials, customer data, or private repositories to public issues.
- The server binds to `127.0.0.1` by default and is designed to run locally. Do not expose its loopback development server directly to the internet.
- Memory Lane includes both reading and writing operations. Ingestion and append operations write library records and manifests; the separately started inbox watcher attempts a no-replace move of successfully ingested source files into a processed folder. Archival can fail after ingestion and is not an atomic transaction with it. Review the selected action and protect source files with independent backups; see [watcher archive limits](docs/WATCHER_ARCHIVE_LIMITS.md).
- Hash and recorded-link checks can reveal some changes relative to the supplied manifest. They do not prove that every expected record or link is present, authenticate a manifest, or detect coordinated replacement of records and manifest. A missing predecessor ID may go unchecked. Memory Lane does not encrypt or hide records; use filesystem permissions and tested backups.
- Ingestion can send text to the configured extraction model. The inbox watcher enables extraction and can reach a hosted endpoint when configured; its Ollama fallback is local by default, but `OLLAMA_URL` can select another host. Review model and network configuration before processing private material. To avoid extraction, use the ingestion CLI's `--no-extract` option; the watcher does not expose that option.

We will acknowledge a valid private report as quickly as practical, investigate it, and publish a fix or mitigation when appropriate.
