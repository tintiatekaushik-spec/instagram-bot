# n8n workflow setup

Start this controller before running n8n:

```powershell
npm start
```

Check that n8n can reach it:

```text
http://localhost:3000/health
```

If n8n runs in Docker, use `http://host.docker.internal:3000` instead of `http://localhost:3000`.
If n8n Cloud is being used, it cannot call your local `localhost` URL directly.

## Recommended node order

Use this order when credentials come from the sheet:

```text
Manual Trigger
  -> Google Sheets Get Rows
  -> HTTP Dashboard Posts
  -> Filter run=yes
  -> Loop Over Items
       loop output -> Sheet Status Pending -> Wait Until Scheduled Time -> Sheet Status Running -> HTTP Start Browser -> HTTP Navigate -> HTTP Like -> HTTP Comment -> IF completed=true -> Sheet Status Done -> Wait -> back to Loop Over Items
       done output -> HTTP Close Browser
```

For normal sequential runs, set `Loop Over Items` batch size to `1`.

For parallel account windows, set `Loop Over Items` batch size to the number of accounts that should run together for that scheduled batch. For example, if 4 account rows have the same scheduled time, set batch size to `4`. The controller keeps a separate browser window per `account_username`.

The monitor dashboard opens automatically. You can also open it manually:

```text
http://localhost:3000
```

For monitoring, use this dashboard:

```text
http://localhost:3000/monitor
```

The dashboard shows every active account as a preview card with its current status.

To show all spreadsheet posts before they start running, add the `HTTP Dashboard Posts` node immediately after `Google Sheets Get Rows`.

URL:

```text
http://127.0.0.1:3000/dashboard/posts
```

Set the body to a JSON expression:

```text
{{ { rows: $items().map(item => item.json), current: $json } }}
```

Leave `Execute Once` off for this node. The controller syncs the full sheet list into the dashboard, then returns the current row back to n8n with `dashboard_synced` added, so the next Filter node can still read `run`, `account_username`, URLs, comments, and every other spreadsheet column.

The dashboard also auto-adds rows when `/schedule/wait`, `/browser/navigate`, `/browser/like`, or `/browser/comment` receives a post URL, but this node is what lets pending spreadsheet rows appear before the loop reaches them.

By default, the real Instagram browser windows are moved offscreen and the dashboard is the main monitoring screen. If you want physical Chrome window tiling, start the controller with `ARRANGE_BROWSER_WINDOWS=true`.

If multiple rows use the same `account_username`, the controller uses one browser for that account and queues the extra work. One Instagram account should not run two posts at the exact same time in two different browsers.

In your screenshot, the first HTTP Request node is not connected to the `loop` output. Drag the bottom `loop` output from `Loop Over Items` into the first node that should run for each row. Then connect the last node inside the loop back into `Loop Over Items`.

## Filter run=yes

Add a Filter node after Google Sheets and before Loop Over Items.

Condition:

```text
{{ ($json.run || '').toString().trim().toLowerCase() }}
is equal to
yes
```

Only rows with `run = yes` will continue. Rows with `run = no` or blank will stop there.

## Sheet status colors

Add these columns after `run`:

```text
action_status | started_at | finished_at | error_message
```

Use these status values:

```text
pending = selected by workflow but waiting for schedule
running = action is active now
done = like/comment completed or duplicate was safely skipped
failed = action did not complete
```

### Google Sheets coloring

Use Google Sheets conditional formatting once. Apply the rules to the whole data range, for example:

```text
A2:K
```

If you want to color only the account cell instead of the whole row, apply the same rules only to:

```text
B2:B
```

If `action_status` is column `H`, add these custom formula rules:

```text
=$H2="done"      -> green
=$H2="failed"    -> red
=$H2="pending"   -> light gray / silver
=$H2="running"   -> light yellow or light blue
```

This is better than changing colors from n8n every time because n8n only has to update text, and Google Sheets handles the row color automatically.

### Sheet Status Pending

Add a Google Sheets `Update Row` node immediately after the `loop` output and before the Wait node.

Configure the node:

```text
Operation = Update Row
Row Number = {{ $('Loop Over Items').item.json.row_number || $json.row_number }}
```

Then set:

```text
action_status = pending
started_at =
finished_at =
error_message =
```

### Sheet Status Running

Add a Google Sheets `Update Row` node immediately after the Wait node and before `HTTP Start Browser`.

Use:

```text
Row Number = {{ $('Loop Over Items').item.json.row_number || $json.row_number }}
```

Set:

```text
action_status = running
started_at = {{ $now.setZone('Asia/Kolkata').toFormat('dd-MM-yyyy HH:mm:ss') }}
finished_at =
error_message =
```

### Sheet Status Done

Add an `IF` node after `HTTP Comment` and before the Google Sheets `Update Row` node. Only send the row to Done when the comment response proves the action actually finished:

```text
{{ $json.completed === true && $json.completedAction?.verification?.visible === true }}
```

For old duplicate rows that were already completed by the same account, this is also safe:

```text
{{ $json.completed === true || ($json.alreadyCompleted === true && $json.completedAction?.verification?.visible === true) }}
```

Then add the Google Sheets `Update Row` node on the true branch.

Use:

```text
Row Number = {{ $('Loop Over Items').item.json.row_number }}
```

Set:

```text
action_status = done
finished_at = {{ $now.setZone('Asia/Kolkata').toFormat('dd-MM-yyyy HH:mm:ss') }}
error_message =
```

Do not set `action_status = done` from a paused, queued, or running response. During manual login/captcha, `/browser/comment` now waits for the real completion; if it is still waiting it returns `423` with `status = running`, so the Done node should not run.

### Sheet Status Failed

For each HTTP node, use n8n's error path or turn on `Continue On Fail`, then route failed items into a Google Sheets `Update Row` node.

Set:

```text
Row Number = {{ $('Loop Over Items').item.json.row_number }}
action_status = failed
finished_at = {{ $now.setZone('Asia/Kolkata').toFormat('dd-MM-yyyy HH:mm:ss') }}
error_message = {{ $json.error?.message || $json.error || $json.message || 'Action failed' }}
```

After the failed-status node, connect back to `Loop Over Items` so the next row can continue.

## HTTP node settings

For every HTTP Request node:

- Method: `POST`
- Response Format: `JSON`
- Authentication: `None`

### HTTP Start Browser

URL:

```text
http://localhost:3000/browser/start
```

Put this node inside the loop before `HTTP Navigate`, turn on `Send Body`, choose JSON, set `Specify Body` to `Using Fields Below`, then add these body fields:

```text
account_username = {{ $json.account_username }}
account_password = {{ $json.account_password }}
```

In this node's settings, set the request timeout to at least `120000` ms because first-time Instagram login can take longer than the default 30 seconds.

The controller will reuse the browser when the next row uses the same account, and switch sessions when the next row uses a different account. If the account does not have a valid saved session yet, it will log in with `account_username` and `account_password`, then save a fresh session under `sessions/account_username.json`.

### Wait Until Scheduled Time

Use n8n's built-in `Wait` node for scheduling. Do not make an HTTP Request node wait for hours or days; n8n will timeout the HTTP call.

Put this node between `Loop Over Items` and `HTTP Start Browser`.

Configure the Wait node to wait until a specific date/time, then set the date/time value to this expression:

```text
{{ $json.schedule_date && $json.schedule_time ? DateTime.fromFormat($json.schedule_date + ' ' + $json.schedule_time, 'dd-MM-yyyy H:mm:ss', { zone: 'Asia/Kolkata' }).toISO() : $now.toISO() }}
```

This means:

- If `schedule_date` and `schedule_time` are present, n8n waits until that Indian time.
- If they are blank, the row continues immediately.
- This works for long waits like 1 day or more because n8n owns the wait, not the controller HTTP request.

Use `DD-MM-YYYY` for the date:

```text
schedule_date = 30-05-2026
schedule_time = 14:30:00
```

You do not need to put schedule values on every post. Put the schedule only on the first row of each batch, then leave the schedule cells blank for the rows that should run immediately after it.

Example for 5 rows where only the first 4 rows should run:

```text
Row 1: schedule_date = 30-05-2026, schedule_time = 17:20:00, run = yes
Row 2: blank schedule_date, blank schedule_time, run = yes
Row 3: blank schedule_date, blank schedule_time, run = yes
Row 4: schedule_date = 30-05-2026, schedule_time = 17:21:00, run = yes
Row 5: blank schedule_date, blank schedule_time, run = no
```

That means rows 1-3 run as the first batch after `17:20:00`, then row 4 waits until `17:21:00`, and row 5 does not run.

Accepted schedule formats:

```text
schedule_date = 30-05-2026
schedule_time = 14:30:00
```

or:

```text
schedule_date = 30/05/2026
schedule_time = 2:30 PM
```

### HTTP Navigate

URL:

```text
http://localhost:3000/browser/navigate
```

Turn on `Send Body`, choose JSON, then add this body field:

```text
account_username = {{ $('Loop Over Items').item.json.account_username }}
url = {{ $('Loop Over Items').item.json.instagram_url }}
```

### HTTP Like

URL:

```text
http://localhost:3000/browser/like
```

Turn on `Send Body`, choose JSON, then add this body field:

```text
account_username = {{ $('Loop Over Items').item.json.account_username }}
url = {{ $('Loop Over Items').item.json.instagram_url }}
```

If Instagram redirects the post URL, the controller likes first and marks the row so the browsing delay happens in the Comment step before posting the comment.

### HTTP Comment

URL:

```text
http://localhost:3000/browser/comment
```

Turn on `Send Body`, choose JSON, then add this body field:

```text
account_username = {{ $('Loop Over Items').item.json.account_username }}
url = {{ $('Loop Over Items').item.json.instagram_url }}
comment = {{ $('Loop Over Items').item.json.comment_text }}
```

The expression preview must show the real sheet text, for example `Awesome scenes`. If it previews `=` or `{{ $json.comment_text }}`, do not run the workflow yet.

Set this node's request timeout to at least `120000` ms. If Instagram redirected the post URL, this step spends about one minute browsing nearby content, then reopens the exact sheet post/reel before typing and posting the comment.

After the comment is posted successfully, the controller records `account_username + post` in `action-history.json`. If the same account receives the same post again, `/browser/navigate` marks it as skipped and the later Like/Comment nodes return `skipped: true` instead of repeating the action. A different account can still perform the same post once. Duplicate/skipped browsers stay open until the final Close Browser node so parallel batches remain stable.

### HTTP Close Browser

URL:

```text
http://localhost:3000/browser/close
```

No body is needed.

## Quick checks

- If `/health` does not load, the controller is not running or port `3000` is blocked.
- If `/browser/navigate` says `Missing url`, the sheet column name in n8n does not match your expression.
- If `/browser/comment` says `Missing comment`, the comment column is empty or the expression points to the wrong field.
- If `/browser/start` says `Missing account_password`, add the `account_password` field to the Start Browser HTTP body.
- If `/browser/start` says `Verification required`, Instagram is asking for OTP, captcha, checkpoint, or another security step that needs manual confirmation.
- Required sheet columns:

```text
instagram_url | account_username | account_password | comment_text | schedule_date | schedule_time | run
```

The session files are created automatically after login, for example `sessions/hellouhfh.json` and `sessions/second_username.json`.
