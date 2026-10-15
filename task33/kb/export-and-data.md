# Export, import and your data

## CSV export

Any project's task list can be exported to CSV from **Project › … › Export › CSV**, with the
current filters applied. One CSV export holds at most **50,000 rows**; a bigger export fails
with `EXPORT_TOO_LARGE`.

For more rows:

- filter the view (for example by date range or status) and export it in parts;
- or, on Business and Enterprise, use the **full workspace export**: **Admin › Data › Export
  workspace**. It contains every project as JSON and CSV files without a row limit, is prepared
  in the background, and a download link (valid 7 days) is emailed to the admin within 24 hours.
- or page through `GET /v2/tasks` in the API.

## Import

Import tasks from CSV, Trello, Asana or Jira in **Project › … › Import**. CSV files must use the
template from the import dialog (`IMPORT_BAD_HEADER` otherwise). Up to 20,000 tasks per import.

## Attachments and storage

Files up to 10 MB on Free and 100 MB on paid plans. Storage: 2 GB on Free, 100 GB per
organization on Team, 1 TB on Business, unlimited on Enterprise.

## Deleting data

Deleted tasks and projects stay in **Trash** for 30 days. An owner can delete the whole
organization in **Admin › Organization › Delete**; data is erased within 30 days, backups within
90.

## Audit log

Business and Enterprise: **Admin › Security › Audit log** lists sign-ins, permission changes,
exports and API key events for the last 12 months.
