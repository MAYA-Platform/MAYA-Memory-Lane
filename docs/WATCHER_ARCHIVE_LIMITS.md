# Inbox watcher archive limits

The watcher ingests an input before attempting to move it into the dated
`processed` folder. The archive step uses a no-replace rename on Windows or
Linux where the filesystem and runtime support it. If the target name exists,
the source stays in the inbox and the existing target is preserved. Other
platforms, unsupported filesystems and cross-filesystem moves fail closed.
The watcher rejects known unsupported platforms and Linux runtimes without the
rename primitive before starting ingestion. That preflight cannot prove that a
particular kernel, filesystem, destination, or cross-device move will support
the later rename, so those failures can still occur after ingestion.

This is a narrow protection for the archive destination. It is not an atomic
transaction across ingestion and moving the input. Ingestion may already have
written a record when archival fails, and an input left in the inbox may be
retried on a later loop. Inspect the library and both paths before retrying.
The existing watcher may return exit status zero despite individual failures;
inspect its output rather than treating a zero status as proof of success.
The watcher does not establish exactly-once processing or protect against a
source being replaced while it is being ingested. Concurrent attempts on the
same source can both report success on Windows even though one archive remains.
Network filesystems and non-Windows platforms need separate validation.

The watcher invokes extraction by default and may send input to a configured
model endpoint. Use only an authorized inbox and maintain independent backups.
