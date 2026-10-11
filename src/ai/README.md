# Source-backed analysis pipeline

This package extracts feedback signals, groups them within vehicle and market scope, and drafts requirements for product-manager review. The local app accepts only selected source-backed customer feedback. API and cloud endpoints reject synthetic records.

## Agent architecture

The local Python AI routes use Microsoft's Agent Framework with the configured OpenAI Responses model provider. Install the runtime with `pip install -r requirements.txt`.

```text
Selected source records
        |
AnalysisOrchestrator (deterministic Python control flow)
        |-- Feedback Extraction Agent
        |-- Evidence Clustering Agent
        `-- Requirement Drafting Agent

Project Q&A --> Project Evidence Assistant
```

The orchestrator owns sequencing, limits, progress reporting, scope isolation, exact-quote checks, and whether a run can be saved. Agents only return typed proposals; Python validates provenance and keeps requirements pending human review. The read-only Q&A assistant is a separate agent because it answers project questions rather than participating in the analysis stages. All framework requests explicitly set `store=False`.

The frontend and local Python bridge keep their existing request/response contract. Test and integration code can still inject an OpenAI-compatible client; normal live runs use Microsoft Agent Framework agents.

The React app reads the workbook and PDF inputs through `src/backend/services/source_files.py`, then passes validated source records to the analysis service. Analysis preserves source IDs, exact-quote checks, file and row locations, uncertainty, and pending decision status. Reference material is kept separate from customer complaints.

Live analysis requires `OPENAI_API_KEY` on the server and the user's explicit action to run it on selected records. The Responses API calls use `store=False`. This setting does not replace project data-use approval.

## Limits

- The source workbooks define the records eligible for analysis; the model does not create feedback rows.
- Quotes are checked against source text. Their interpretation and the proposed requirements still need human review.
- Counts are file counts, not population prevalence.
- The analysis package does not fetch web pages or download files. A future collector can save an XLSX/PDF in the project source folder and use the same generic reader before source classification.
- Do not put API keys or raw customer data in Git.
