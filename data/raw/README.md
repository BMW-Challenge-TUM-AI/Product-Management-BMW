# Local source files

Put private XLSX/PDF source files in this folder before starting the local app.
The app reads these files through the local backend and does not commit them.

For the built-in BMW data library/default bootstrap, use these filenames:

- `F70_feedback_hackathon.xlsx`
- `G60_feedback_hackathon.xlsx`
- `G70_feedback_hackathon.xlsx`
- `F70_G60_G68_G70_customer_studies.xlsx`
- `sales_volumes.xlsx`
- `F70_OptionList.PDF`
- `G60_OptionList.PDF`
- `G70_OptionList.PDF`
- `f70_equipment_curated.csv`

Generic XLSX/PDF files placed here are discoverable by the project source-file
reader. To turn a new workbook into default dashboard datasets, add or extend an
adapter in `src/backend/services/bmw_library.py` so it maps the workbook rows to
the app's dataset and source-record shape.
