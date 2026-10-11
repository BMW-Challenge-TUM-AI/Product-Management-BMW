# Source-backed analysis pipeline

This package extracts feedback signals, groups them within vehicle and market scope, and drafts requirements for product-manager review. The local app accepts only selected source-backed customer feedback. API and cloud endpoints reject synthetic records.

The React app reads the workbook and PDF inputs through `src/backend/services/source_files.py`, then passes validated source records to the analysis service. Analysis preserves source IDs, exact-quote checks, file and row locations, uncertainty, and pending decision status. Reference material is kept separate from customer complaints.

Live analysis requires `OPENAI_API_KEY` on the server and the user's explicit action to run it on selected records. The Responses API calls use `store=False`. This setting does not replace project data-use approval.

## Limits

- The source workbooks define the records eligible for analysis; the model does not create feedback rows.
- Quotes are checked against source text. Their interpretation and the proposed requirements still need human review.
- Counts are file counts, not population prevalence.
- The analysis package does not fetch web pages or download files. A future collector can save an XLSX/PDF in the project source folder and use the same generic reader before source classification.
- Do not put API keys or raw customer data in Git.
