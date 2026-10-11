# BMW InsightPilot

## Project description

BMW InsightPilot is a product intelligence workspace for turning source-backed vehicle feedback into reviewable product requirements. The platform loads supplied XLSX and PDF material, preserves provenance down to workbook sheets, rows, and PDF pages, and separates customer verbatims from internal studies, equipment data, catalog records, and sales context. Product teams can select a vehicle and market scope, inspect the underlying evidence, run AI-assisted analysis on bounded batches of real customer comments, and convert findings into requirement proposals that remain pending human review. The system is designed for traceability: every generated insight, requirement, priority, and report can be checked against source material. A read-only AI assistant, with text and voice interaction, helps teams ask natural follow-up questions about the current project, evidence gaps, analysis coverage, and recent decisions without giving the assistant authority to approve or change requirements.

## Platform workflow

1. **Load source material**: Put the supplied XLSX and PDF files in `data/raw/`. The app discovers supported files and keeps them out of Git.
2. **Choose project scope**: Open **Data Sources**, select the BMW vehicle series and market, and review the available customer feedback, studies, equipment, and sales context.
3. **Inspect evidence**: Use the source viewer and Evidence Explorer to open the exact workbook row, sheet, or PDF page behind a record.
4. **Run source-grounded AI analysis**: Select up to 50 customer feedback records and start analysis. The backend accepts source-backed verbatims only and blocks synthetic records.
5. **Review generated findings**: AI outputs are proposals, not final decisions. Findings and draft requirements stay linked to the original evidence.
6. **Prioritize requirements**: Add PM impact, strategy, feasibility, and rationale scores. The platform keeps scoring assumptions versioned and auditable.
7. **Export and communicate**: Generate PDF reports with source statistics, analysis coverage, requirements, quotations, counterevidence, scoring gaps, and decision history.

## Most interesting features

- **Agentic AI framework**: The analysis pipeline is organized as bounded agents that extract, cluster, generate, and validate requirement proposals. The orchestrator owns sequencing, limits, progress reporting, scope isolation, provenance checks, and save eligibility.
- **Source-grounded outputs**: The system validates quotes and links before displaying AI findings. It keeps customer comments separate from internal reference material to avoid false prevalence claims.
- **Ask InsightPilot chatbot**: A read-only assistant answers questions about project counts, customer themes, evidence gaps, requirements, analysis runs, priorities, and decisions using the current workspace context.
- **Voice-enabled assistant**: Users can ask questions through the microphone, receive transcribed prompts, and listen to spoken AI answers. API keys remain server-side.
- **Traceable file explorer**: XLSX and PDF records can be opened from the app with their original sheet, row, page, and file references.
- **Resumable analysis jobs**: Long-running local analysis jobs keep progress across page navigation and browser refreshes.
- **Human-in-the-loop governance**: Requirements require PM review, scoring rationale, and decision history. The assistant cannot approve, reject, or edit project decisions.