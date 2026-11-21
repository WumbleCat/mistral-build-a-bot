"""Stage E - optional grounded catalog search.

Nothing here invents products. Candidates come only from a configured catalog API,
with the product URL exactly as that API returned it. Without a configured catalog
the result is an empty list and the status ``Catalog lookup not configured``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Protocol

import httpx

from .config import Settings
from .models import CatalogCandidate, Component, EvidenceType
from .taxonomy import name_tokens

log = logging.getLogger(__name__)

NOT_CONFIGURED = "Catalog lookup not configured"


class CatalogClient(Protocol):
    status: str

    def search(self, query: str) -> list[dict]:
        """Return raw product records from the catalog. Never fabricate results."""
        ...


class NullCatalogClient:
    status = NOT_CONFIGURED

    def search(self, query: str) -> list[dict]:
        return []


class HttpCatalogClient:
    """Generic JSON catalog adapter.

    ``GET {CATALOG_API_URL}?q=<query>`` must return either a list of product objects or
    ``{"results": [...]}``, each with ``title``, ``product_url`` and optionally ``vendor``,
    ``sku``, ``price``, ``currency``. Adapt ``_normalise`` for a specific supplier API.
    """

    def __init__(self, url: str, api_key: str | None = None, *, http_client: httpx.Client | None = None) -> None:
        from .vision import system_trust_context

        self._url = url
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._client = http_client or httpx.Client(timeout=30, verify=system_trust_context())
        self.status = "Catalog lookup configured"

    def search(self, query: str) -> list[dict]:
        try:
            response = self._client.get(self._url, params={"q": query}, headers=self._headers)
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("catalog search failed (%s); returning no candidates", exc.__class__.__name__)
            self.status = "Catalog lookup failed; no candidates returned"
            return []
        records = body.get("results", []) if isinstance(body, dict) else body
        return [r for r in records if isinstance(r, dict)] if isinstance(records, list) else []


def build_catalog_client(settings: Settings) -> CatalogClient:
    if settings.catalog_api_url:
        return HttpCatalogClient(settings.catalog_api_url, settings.catalog_api_key)
    return NullCatalogClient()


def _query_for(component: Component) -> str:
    verified = [component.manufacturer, component.model, component.sku]
    parts = [p for p in verified if p] or [component.name]
    return " ".join(parts)


def find_candidates(
    components: list[Component], catalog: CatalogClient, *, per_component: int = 3
) -> list[CatalogCandidate]:
    """Search for observed or human-confirmed components; rank, never auto-confirm."""
    candidates: list[CatalogCandidate] = []
    for component in components:
        if component.status == "rejected":
            continue
        if component.evidence_type is not EvidenceType.OBSERVED and component.status != "confirmed":
            continue  # do not shop for parts nobody has seen or confirmed
        query = _query_for(component)
        queried_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        wanted = name_tokens(query)
        scored: list[CatalogCandidate] = []
        for record in catalog.search(query):
            title, url = record.get("title"), record.get("product_url") or record.get("url")
            if not isinstance(title, str) or not isinstance(url, str):
                continue  # no verified title + URL -> not a usable candidate
            overlap = len(wanted & name_tokens(title)) / len(wanted) if wanted else 0.0
            sku = record.get("sku")
            sku_match = bool(component.sku and sku and str(sku).strip().lower() == component.sku.lower())
            try:
                price = float(record["price"]) if record.get("price") is not None else None
            except (TypeError, ValueError):
                price = None
            try:
                scored.append(
                    CatalogCandidate(
                        component_id=component.id,
                        vendor=str(record.get("vendor") or "unknown vendor"),
                        title=title,
                        sku=str(sku) if sku else None,
                        price=price,
                        currency=record.get("currency") if price is not None else None,
                        product_url=url,
                        evidence_notes=(
                            ("Exact SKU match with the reviewed part number. " if sku_match else
                             "Text match only - not verified against the physical part. ")
                            + f"Query: '{query}'."
                        ),
                        compatible=None,  # compatibility is never assumed from a search hit
                        query=query,
                        queried_at=queried_at,
                        match_score=round(min(1.0, overlap + (1.0 if sku_match else 0.0)), 3),
                    )
                )
            except ValueError:
                continue  # malformed record (e.g. relative URL): drop rather than repair
        scored.sort(key=lambda c: c.match_score or 0.0, reverse=True)
        candidates += scored[:per_component]
    return candidates
