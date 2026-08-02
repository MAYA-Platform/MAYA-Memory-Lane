# Security Policy

## Supported versions

Security reports are accepted for the latest public-beta release published from this repository.

## Reporting a vulnerability

Use GitHub's **Private vulnerability reporting** feature for anything sensitive. Do not place exploit details, credentials, personal data, or private repository contents in a public issue.

For non-sensitive bugs, open a normal GitHub issue with reproduction steps, expected behavior, actual behavior, environment details, and sanitized evidence.

## Boundaries

- This project is a public beta, not a production service.
- Keep all tests on data and systems you own or are authorized to inspect.
- Do not upload live credentials, customer data, or private repositories to public issues.
- The server binds to `127.0.0.1` by default and is designed to run locally; do not expose its loopback development server directly to the internet.
- The library reader is read-only: it never writes to, mutates, or reorganizes library files. It is a window over the files, not a replacement for them.
- Memory Lane is a tamper-evident *record* system, not an encryption layer. It detects changes to your records; it does not hide them. Protect your library directory with normal filesystem permissions and back it up like any other valuable data.

We will acknowledge a valid private report as quickly as practical, investigate it, and publish a fix or mitigation when appropriate.
