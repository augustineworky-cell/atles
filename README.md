# DCC Attendance

Internal attendance dashboard for DCC / DDC Supply Chain.

```
Google Form ──► Google Sheet ──► Apps Script (SupabaseSync) ──► Supabase  ◄── Vercel (site + /api) ◄── browsers
   raw capture      raw record        one-way, append-only         main DB         GitHub → auto deploy
```

* **Supabase** = main database (employees, punches, corrections, branch entries, audit logs). All rules live in SQL (views + RPCs).
* **Vercel** = serves `public/` and the serverless API `api/rpc.js` (the old Apps Script `WebApp.gs`, ported 1:1). The Supabase secret key lives only in Vercel env vars.
* **Google Form / Sheet** = untouched raw capture. See [docs/SYNC.md](docs/SYNC.md).

## Folder map
```
api/rpc.js            single API door (whitelist of functions)         api/health.js   sync + DB status
lib/                  handlers (all dashboard functions), auth tokens, Supabase client, Excel export, Drive photos
public/index.html     the dashboard   public/css/app.css (all styling)   public/css/fx.css (motion)
public/js/app.js      dashboard logic public/js/fx.js (sparks + petals canvas)   public/img/ (Maa, dhak, art)
sql/                  02→06 database scripts (already applied on your project; keep for rebuilds)
apps-script/          SupabaseSync.gs (raw sync) + FormDropdownSync.gs
test/                 offline unit tests          scripts/  dev server, env check, browser smoke test
```

## Run locally (VS Code)
```bash
npm install
cp .env.example .env      # fill the values (Supabase URL + secret key, ADMIN_PIN, SESSION_SECRET, branch PINs)
npm run check             # shows what is set + proves Supabase answers
npm run dev               # http://localhost:3000
npm test                  # 18 offline tests
```

## Deploy (GitHub → Vercel)
1. `git init && git add . && git commit -m "DCC Attendance" ` → create a **private** GitHub repo → push.
2. vercel.com → Add New → Project → import the repo (Framework: *Other*; no build command; output dir blank).
3. Settings → Environment Variables → add everything from `.env.example` (Production + Preview). **Never commit `.env`.**
4. Redeploy. Open `/api/health` (should say `ok: true`) and the site.
5. Optional: set `SITE_PASSWORD` so only people with the password can open the dashboard.

## Environment variables
| Name | Needed | Meaning |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | yes | Supabase project + secret (service_role) key |
| `ADMIN_PIN` | yes | admin mode PIN (6+ chars) |
| `SESSION_SECRET` | yes | 40+ random characters; signs admin/branch sessions |
| `BRANCH_PIN_OKHLA`, `BRANCH_PIN_GURGAON`, `BRANCH_PIN_SAFDARJUNG_HO` | per branch | branch portal PINs (name = `BRANCH_PIN_` + LOCATION, other characters → `_`). No PIN = branch cannot log in |
| `SITE_PASSWORD` | optional | password in front of the whole site |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | optional | punch photos (see `lib/drive.js` header) |

## Moving from the Apps Script version
* Everything keeps the same names/behaviour. Differences: Excel report downloads directly (no Google Sheet copy is created in Drive);
  Form dropdown refresh is done by `FormDropdownSync.gs` within 10 min instead of instantly; branch audit entries also store the user's IP address;
  branch actor name is the typed name (no Google e-mail anymore).
* Bug fixed in the Excel summary: the "Sundays" cell was one short when the *Data up to* date fell on a Sunday.
* Run `06_branch.sql` once if you have not already (branch portal tables/RPCs).

## Security notes
* Browser never sees the Supabase key; every admin/branch call re-checks an expiring HMAC token. Lockout (5 wrong PINs → 15 min) is enforced in Supabase.
* RPCs are `service_role`-only; tables have RLS. Rotate `SUPABASE_SECRET_KEY` / `SESSION_SECRET` if they are ever pasted anywhere public.

## Themes: Premium daily + Festive mode
- `Theme` button cycles: **Auto -> Premium -> Festive (Durga Puja) -> Hydrangea**. Default is **Auto**.
- **Auto** = Premium every normal day, Festive on the festival dates. Dates are in `public/js/theme.js` (`FESTIVE`), edit them when needed.
- Premium look = `public/css/premium.css` (navy + gold hairline, Plus Jakarta Sans). Festive/Hydrangea CSS is untouched.
- Status colours mean the same in every theme.

## Night / Extra day filter
- Above the staff list: **All | Night | Extra day** chips (click again to clear). Same choice is in Filters > Staff > *Special duty* (adds "Night or Extra day").
- The list shows only staff who have that duty in the selected period (Today / 7 days / Month / custom dates), with small badges per person (night count, E = extra days).
- Dashboard pages (Overwork, Summary etc.) follow the same filter. *Clear all* resets it.

## Animations (Durga theme)
Only `transform`/`opacity` are animated; particles are one canvas with ~40 pre-rendered sprites; pauses in hidden tabs; respects *reduce motion*;
auto-drops to a lighter mode on slow PCs. Flower button (✿) turns sparks/petals off. `npm run smoke` (needs `npm i -D playwright`) screenshots the site and checks for JS errors.


## Salary preview (extra feature, admin only)
A separate **Salary (preview)** page that appears in Admin mode. It only READS attendance and a private `employee_salary` table;
it is **not** used by the month-end Excel, so the final report is unchanged.
Rules: one day = monthly salary / days in the month; Present 1, Half Day 0.5, Absent 0; Sunday and Holiday paid, except a Sunday with an
Absent working day before AND after it (long leave); Extra Day = that day + one extra day's salary; Missing punch paid as a full day for now;
days before joining / after leaving are not paid. Night duty, EPF and ESIC are not calculated yet.
Setup (once): run `sql/07_salary.sql` then the salary load script (08_load_salaries.sql, kept out of GitHub because it holds salaries) in the Supabase SQL Editor. The rules live in `lib/salary.js` (with tests).

## Daily board
A page for everyone (left menu, under Overview): pick a day (Today / Yesterday / any date) and see attendance for all staff:
KPI cards with trend and 'vs previous day', a 14-working-day line, a per-branch table (click to filter) and a tabbed employee list
(Absent / Present / Half-Extra / Missing punch / All) with search and CSV. Sundays and holidays show a day-off note; today's
staff who have not punched yet show as 'Not in yet', not absent. It only reads the same attendance data (no salary on this page).
