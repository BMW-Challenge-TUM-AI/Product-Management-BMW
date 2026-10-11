"""Strict structured-output schemas used by the analysis pipeline."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator


Category = Literal[
    "Comfort", "Charging", "UX", "Interior", "Digital Services",
    "Storage", "Technology", "Safety", "Performance", "Other",
    "Space & Practicality", "Usability", "Infotainment & Digital Services",
    "Design & Perceived Quality", "Driving Experience", "Range & Charging", "Equipment & Packages",
]
FindingType = Literal["complaint", "unmet_need", "positive_feedback", "unclear"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class FeedbackRecord(StrictModel):
    source_id: str
    vehicle: str
    text: str
    market: str | None = None
    source_type: str | None = None
    source_file: str | None = None
    source_location: str | None = None
    metadata: dict | None = None

    @field_validator("source_id", "vehicle")
    @classmethod
    def require_nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value must be non-empty")
        return value


class FindingExtraction(StrictModel):
    finding_type: FindingType
    category: Category
    summary: str
    customer_need: str
    evidence_quote: str
    needs_review: bool
    uncertainties: list[str]


class ExtractionBatch(StrictModel):
    findings: list[FindingExtraction]


class RecordExtraction(ExtractionBatch):
    source_id: str


class MultiRecordExtraction(StrictModel):
    records: list[RecordExtraction]


class SemanticCluster(StrictModel):
    title: str
    summary: str
    category: Category
    finding_type: FindingType
    finding_ids: list[str]
    uncertainty: str


class ClusteringBatch(StrictModel):
    clusters: list[SemanticCluster]


class ScopedClustering(ClusteringBatch):
    scope_id: str


class MultiScopeClustering(StrictModel):
    groups: list[ScopedClustering]


class RequirementDraft(StrictModel):
    description: str
    category: Category
    rationale: str
    confidence: Literal["low", "medium", "high"]
    assumptions: list[str]
    uncertainties: list[str]


class ClusterRequirementDraft(RequirementDraft):
    cluster_id: str


class RequirementDraftBatch(StrictModel):
    drafts: list[ClusterRequirementDraft]
