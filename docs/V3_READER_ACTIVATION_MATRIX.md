# V3 reader and activation matrix

This is a source and isolated-runtime acceptance record. `PASS` means the
described disposable-library check ran; it does not mean a production profile
was reconfigured. Fixture tokens and records are synthetic.

| Surface | Isolated result | Scope, provenance, temporal, freshness proof | Production activation |
| --- | --- | --- | --- |
| HTTP `/api/v3/query`, `/api/v3/recent` | PASS | Bearer principal, namespace filter, hash-checked evidence, explicit temporal query, 30-day recent window, malformed request rejection | OFF |
| HTTP legacy search/answer | PASS | Policy-enabled routes enforce principal scope; existing single-owner routes retain legacy behavior | V1 live; V3 OFF |
| CLI `query`, `recent` | PASS | Policy token, scoped source, recent window; no-policy V3 calls fail closed | OFF |
| CLI legacy search/answer/resume | PASS | Policy-scoped answer uses V3 planner; policy-scoped resume denied; legacy mode remains available | OFF |
| MCP `ml_query`, `ml_recent` | PASS | JSON-RPC client, scoped evidence, no anchor or other-client fixture leakage | OFF |
| MCP legacy search/answer/resume | PASS | Policy-scoped search/answer use V3 planner; policy-scoped resume denied; Jev requires namespace opt-in | OFF |
| Hermes MemoryProvider | PASS on installed local runtime | Actual `MemoryManager.on_turn_start` dispatch, scoped CLI prefetch, session switch and metadata-only local receiver; transcript ignored | OFF |
| Session freshness writer | PASS in isolated suite | Authenticated namespace writer; `SESSION_OPEN`/`WAKE` and malformed-event tests | OFF |
| Jev decisions | Synthetic test only | Failure/timeout abstention; zero actual provider calls in offline benchmark | OFF pending private calibration |
| Four private feeders | UNVERIFIED | Revisions, principals, namespaces, hooks and closeout sources absent from this checkout | OFF |
| Active team profiles | UNVERIFIED runtime state | Current profile YAML check below; runtime environment and route read-back remain required | OFF |

## Profile YAML read-back

The 11 profile directories were inspected read-only. None of their top-level
YAML files contains `MEMORY_LANE_ACCESS_TOKEN`, `MEMORY_LANE_NAMESPACE`, or
`MEMORY_LANE_SESSION_URL`. A library path key appears in ten profiles. This
does not inspect protected environment injection or prove a live route.

| Profile | Library key in YAML | V3 identity, namespace, session URL in YAML | V3 activation |
| --- | --- | --- | --- |
| chib | absent | absent | unverified / off |
| chief | present | absent | unverified / off |
| forge | present | absent | unverified / off |
| herald | present | absent | unverified / off |
| keira | present | absent | unverified / off |
| nova | present | absent | unverified / off |
| plumb | present | absent | unverified / off |
| recon | present | absent | unverified / off |
| scribe | present | absent | unverified / off |
| shadow | present | absent | unverified / off |
| specter | present | absent | unverified / off |

Activation record for each profile must contain profile ID, owner, principal,
read/write namespaces, endpoint, plugin revision, synthetic receipt IDs, and
rollback config hash. No profile is marked active from a source test.

2ndNatureAi
