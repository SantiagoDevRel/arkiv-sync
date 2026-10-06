# SDK0.8.1 verification

The earlier local arkiv-sync0.3.0 candidate passed eight actual Tiramisu cases with22 confirmed transactions on October6,2026. The tested combination was SDK0.8.1 and viem2.57.3. The [historical sanitized evidence](sdk-0.8.1-evidence.json) binds the earlier compiled entry and archive; it does not assert publication or cover later bundle changes.

The suite wrote201 synthetic rows, read three pages at one snapshot, checked exact integer sorting, exercised replacement/unset and expiration extension, and verified scoped reconciliation and file-checkpoint recovery without resending confirmed writes. Reorg/header and checkpoint-save failures were controlled injections. No natural consensus reorganization is claimed.

A separate actual exported EvmSource HTTP check read native EntityCreated events from one confirmed block through a bounded parent proxy: six forwarded reads,22 observed events and two matched task events, with zero new transactions. The main indexer used an injected native-log adapter; these scopes are recorded separately. External ERC20 providers, deployed applications, scaffold CLI execution and HTTP send-response loss followed by process restart were not exercised here.

## Current admission fix and application continuation

The current candidate validates sink admission before constructing the source transport. Without a signing key, `createIndexer` and `quickCheck` now fail before background RPC sampling. All52 offline cases, typecheck/build and18 packed-scaffold checks passed. The scaffold includes consumer guides, protects nonempty directories and uses the exact local0.3.0 archive; its separate npm publication remains pending.

Three actual continuation cases passed with the current compiled entry: public EvmSource/Indexer/ArkivSink, pinned Reader/SQLite reopen, and authenticated API/React rendering. One derived transaction reused an authenticated earlier three-row batch; the batch was not recreated. Four exact typed rows traversed two pages, SQLite reopened in a new process, checkpoint replay wrote nothing, API authorization preceded database access, and logout cleared the browser cache. Five widths and native200% zoom were observed. [Current source digests, scoped cases and receipts](current-candidate-evidence.json).

The new entry changes two factory admission orderings. The earlier source, engine, sink and reader inputs remain identical, but the historical22-write record is not relabeled as execution of the new bundle. The application recipe uses local SQLite and a temporary identity service; production identity, hosted SQL/RLS, arbitrary external contracts and natural reorganization remain unverified. Neither record proves npm publication.
