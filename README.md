# Instagram Automation Dashboard

Browser-based Instagram automation controller with a live monitor dashboard, account sessions, queued actions, manual verification handling, and n8n/Google Sheets workflow support.

## Main Files

- `controller.js` - Express controller, Playwright browser automation, queue handling, and dashboard APIs.
- `dashboard.js` - Browser monitor UI.
- `save-session.js` - Helper for saving Instagram browser sessions.
- `N8N-WORKFLOW.md` - Workflow setup notes for n8n and Google Sheets.

## Local Runtime Data

Session files, logs, screenshots, generated thumbnails, and action history are ignored by Git because they can contain account-specific or sensitive data.
