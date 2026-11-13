# Inbox watcher archive limits

The watcher first checks whether the selected dated `processed` path already
exists and stops before ingestion if it does. This early check is advisory: a
destination can appear after the check, while ingestion is in progress. The
date is chosen when processing that file starts, including across midnight.
The watcher then ingests the input before attempting to move it. The archive
step uses a no-replace rename on Windows or
Linux where the filesystem and runtime support it. If the target name exists,
the source stays in the inbox and the existing target is preserved. Other
platforms, unsupported filesystems and cross-filesystem moves fail closed.
The watcher rejects known unsupported platforms and Linux runtimes without the
rename primitive before starting ingestion. That preflight cannot prove that a
particular kernel, filesystem, destination, or cross-device move will support
the later rename, so those failures can still occur after ingestion.

This is a narrow protection for the archive destination. It is not an atomic
transaction across ingestion and moving the input. Ingestion may already have
written a record when archival fails. The watcher stops the current run and
returns nonzero on the first failure or unconfirmed outcome; other files in the
same scan remain unprocessed. Inspect the library and both paths before
restarting. This behavior changes the prior per-file failure exit and loop
behavior, so update callers that expected a zero exit or continued looping.
It is not a durable hold: a separate cron or scheduler invocation can retry an
input left in the inbox without checking whether ingestion already succeeded.
The watcher does not establish exactly-once processing or protect against a
source being replaced while it is being ingested. Concurrent attempts on the
same source can both report success on Windows even though one archive remains.
Network filesystems and non-Windows platforms need separate validation.

The watcher invokes extraction by default and may send input to a configured
model endpoint. Use only an authorized inbox and maintain independent backups.
