# TODO — Unlimited-bot

## Summary checklist (high level)
admin orders
- [x] Create sample order command (`/create_new_order`) — Done
admin stats:
need to keep track of different shifts, the simple way, creating a new profile, prompt only for name and 4 digits password with confirmation.
create sub-menu: [NEW PROFILE], [new profile created name 1], [new profile created name 2], [new profile created name 3].
stats start when a shift is opened, when a new profile connects.
add a fancy title: 📊 PROGRESSION (`profile_name`), 
add new fields Connected drivers, total stars (total star collected from all the drivers), shift started since `stopwatch_value`
attach inline button [Close shift] on close save the shift details under profile name (backend only)



admin settings
-manage admin
,
*create new function , need to set 5186573916 is superadmin)* [➕ADD] button, generate a 1 time use bot link to forward to a user to be promoted as admin, when user click the link, bot reply "Registration processing, please wait a few moment...", prompt super admin for approval, need to suspend/lock superadmin account, need to set a new reply blocked keyboard;  [⚠️UNBLOCK], [📊STATS], all admins feature are assigned to new admin, superadmin would have to press UNBLOCK to gain access back to his interface, previous admin account is suspended (frozen interface) until superadmin reactivate admin account from Manage admin settings.

-manage qr
-manage driver
-emoji mode (no label mode for admin)

driver
- Driver language 
-live location with customer 
-live location with admin

customer
- [ ] Customer ordering flows (text/contact/location mapping) — Partial
- [ ] Payment / QR flows
- [ ] Live session timers & expiry scheduling 

keyboards
- [ ] Inline callback handlers and detailed inline keyboard
- back button (emoji and behavior).
-remove back buttons from list views
-driver keyboard (driverReadyKeyboard) is wrong, it has on pickup and map buttons.
remove start button (this function should be assigned to location button driverActiveOrderKeyboard )remove stop live button (stop live automatically when driver press ARRIVED button from driverActiveOrderKeyboard)


## Feature mapping (concise)

Admin / Order management
- Admin main keyboard/menu — Partial: keyboard constants exist but full UI and edit interactions need completion.
- Order list by sections + inline order buttons — Partial: functions exist but implementations incomplete or unverified.
- Edit-mode flows (map media/text  order fields, CASH/QR payment editing, given_cash  change) — Partial.

Driver management
- `/register` flow + admin notification — Partial.
- Driver approve/unblock UI & online/offline keyboards — Partial/Not implemented.
- Driver stats / summary cards — Not implemented.

Customer flows
- `/start` registration and minimal instructions — Partial (handler present; richer ordering UI missing).
- Accepting contact/location/media to populate order — Partial.

Payments & QR
- `qrCodes` array present — Partial. Full admin QR management UI (add/select/activate) missing.
- Payment marking (PAID/CASH/QR) & cash-change calc — Partial (logic not verified).

Live sessions & tracking
- Session start/stop and timers — Partial (timer map exists; confirm scheduling logic).
- ETA / maps link generation — Partial.

Persistence & data safety
- `loadData()` and `saveData()` exist — Partial: confirm they restore `orderCounter` and use safe atomic write.
- Autosave/archiving scheduling — Not implemented.

Logging & infra
- Group logging to file — Partial (append function present; rotation needs review).
- Polling error suppression/backoff — Partial.

Utilities / developer
- `/create_new_order` — Done
- Admin utils (`/setsetting`, `/fetchmsg`, `/clear_admin_ui`) — Partial (handlers present, verify behavior)

## Debug / Investigation tasks
1. Check `loadData()` restores `orderCounter`, `orders`, `drivers`, `customers`, `SETTINGS`, `qrCodes` correctly — Debug
2. Ensure `saveData()` writes atomically (temp file + rename) to avoid corrupt `data.json` on crash — Debug
3. Inspect message handlers: multiple `bot.on('message', ...)` usages may conflict (group logging vs generic handlers). Consolidate dispatcher or ensure ordering — Debug
4. Verify `sessionTimers` items are cleared on stop and on restart to avoid leaks — Debug
5. Confirm single source for `GROUP_LOG_ROTATE_BYTES` (constant retained but group logging removed) — Done
6. Check admin temp message TTL cleanup (`adminTempMessages`) on restart and on message deletion — Debug
7. Ensure webhook deletion + polling start sequence is correct (bot created with polling: false) to avoid 409 conflicts — Debug
8. Add tests for critical flows: persistence, order id generation, payment marking — Debug

## Prioritized next steps (recommendation)
1. Run quick verification: open and inspect `loadData`, `saveData`, `formatOrder`, message handlers, and session timer code (this will convert many "Partial" items into Done/Not implemented).
2. Fix obvious issues: atomic `data.json` writes, consolidate message handling, confirm `orderCounter` persistence.
3. Implement high-value features: QR admin flows, full edit-mode contentfield mapping, driver assignment + ETA link.

## Notes
- The above was produced by comparing the project plan in `initial-prompt.txt` and the scaffold in `index.js` (many functions are present but bodies were incomplete / elided in the scaffold). Use the Debug tasks to guide a rapid triage pass.

---
If you want, I can now:
- open and validate the specific functions listed in the Debug section, or
- implement one prioritized fix (safe persistence or consolidate message handlers). Pick one and I'll proceed.
