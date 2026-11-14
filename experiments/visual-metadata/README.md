# Visual metadata: synthetic local fixture

This offline experiment models a user explicitly selecting an invented item and entering a short metadata label. It captures no screens, images or pixels, performs no OCR, reads no personal files, has no network and does not connect to Memory Lane or a live app. It stores only fixture IDs, application labels and short text in an in-memory map. The caller must supply explicit opt-in and selection flags, an exact fixture scope, and a synthetic source claim; searches return local matching labels only.

Within this one instance, removing an ID prevents it being re-added, and excluding an exact application label removes its existing records and blocks further entries for that label. Disabling opt-in stops new entries and search but does not erase the map; re-enabling restores records that were not explicitly removed or excluded. Scope labels, the source flag and selection are caller assertions, not authenticated owner identity, consent or proof that data is synthetic. Application exclusion is exact text, not robust application identity.

No authoritative deletion is established: copied results cannot be recalled, tombstones disappear with the process, and this fixture cannot erase screenshots, indexes, logs, backups, model prompts, external copies or future re-ingestion. Real deployment would require an owner-controlled source and permissions, stable app identities, default exclusions, durable deletion/tombstone propagation and audit, storage protection, explicit retention controls and egress consent. None is implemented here. Do not connect this prototype to personal images or production.

Source inspection: Memory Lane's `tools/ingest.mjs` seals text into a library through `lib/extract.js`; `lib/memoryLaneCore.js` searches captured library snapshots and `lib/libraryFingerprint.js` supplies those snapshots. This fixture intentionally does not call those interfaces: their existing snapshot/search path does not establish an authoritative delete-everywhere contract for visual records.

Run `node --test experiments/visual-metadata/fixture.test.mjs`.
