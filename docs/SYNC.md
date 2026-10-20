# Raw sync: Google Form → Supabase (unchanged, keep it running)

```
Staff phone → Google Form → Sheet "Form responses 3" → SupabaseSync.gs → Supabase raw_punches
                                                                         ↓ (views + RPCs)
                                                      Vercel /api/rpc → Dashboard
```
The Form + Sheet stay the **raw, untouchable record**. Supabase gets a one-way, append-only copy
(`punch_id` is a hash, so running the sync twice never creates duplicates). Nothing in the dashboard writes back to the Sheet.

## What runs where
| Where | What | When |
|---|---|---|
| Apps Script (`apps-script/SupabaseSync.gs`) | `sbSyncPunches` copies new Form rows to `raw_punches` | on every Form submit + every 5 min (safety net) |
| Apps Script | `sbWatchdog` e-mails you if no successful sync for 3 h (06:00–23:00 IST) | hourly |
| Apps Script (`FormDropdownSync.gs`) | `fdSync` makes the Form name dropdowns match Supabase staff | every 10 min |
| Vercel `/api/health` | shows latest punch time + last sync + `running / slow / STOPPED` | whenever you open it |

## One-time setup (≈5 minutes)
1. Open the Sheet → Extensions → Apps Script (the same project you already use).
2. Replace `SupabaseSync.gs` with `apps-script/SupabaseSync.gs`; add a new file `FormDropdownSync.gs` from this repo.
   (You can delete the old `WebApp.gs` and `index.html` from Apps Script — the dashboard now lives on Vercel. Keep them until Vercel works.)
3. Script properties already exist: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SHEET_ID`.
4. Run `sbTestConnection` → should log `200`.
5. Run **`sbSetupTriggers`** once (re-creates: on-submit, every 5 min, hourly watchdog).
6. Run `fdCheck` once (Google asks for Form permission → Allow), then `fdSetupTrigger` once.
7. Open `https://<your-site>.vercel.app/api/health` → `"sync_status": "running"`.

## If the sync stops
* Apps Script → Executions: look for a red run → the error text tells you (usually an expired authorisation or a changed key).
* Run `sbSyncPunches` by hand — it catches up on everything (it re-reads the last 5000 rows, duplicates are ignored).
* Punches are never lost: the Sheet still has every row.
