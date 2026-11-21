"""The optional "AI best guess" step: design choices, simple component list, shop links."""

import json

import pytest
from fastapi.testclient import TestClient

import robot_bom.api as api
import robot_bom.cli as cli
from robot_bom.config import Settings
from robot_bom.design import (
    SHOPS, InferredDesign, SourcingPlan, clean_query, infer_and_source, shop_links,
)
from robot_bom.extraction import VisionResponseError
from robot_bom.models import ReviewIssue, RobotBOM
from robot_bom.pipeline import analyze
from robot_bom.vision import MockVisionClient

from conftest import hidden, make_images, observed, png_bytes

DESIGN = {
    "summary": "2WD rover",
    "design_choices": [{"issue_id": "drivetrain.unknown", "choice": "2 rear gear motors", "reason": "common kit"}],
    "components": [
        {"name": "rubber wheel", "category": "wheel", "quantity": 4, "basis": "observed"},
        {"name": "DC gear motor", "category": "motor", "quantity": 2, "specs": {"voltage_v": 6, "note": None},
         "basis": "inferred", "sku": "INVENTED-1", "url": "https://shop.example/invented"},
        {"name": "18650 cell", "category": "not-a-category", "quantity": 2, "basis": "inferred"},
    ],
}
SOURCING = {
    "power_budget": "6 V, about 1 A (estimate)",
    "searches": [
        {"component": "DC Gear Motor ", "search_query": "TT gear motor 6V 1:48 https://evil.example/x?<b>",
         "recommended_sites": ["Amazon", "sparkfun", "ebay", "amazon"], "note": "check shaft",
         "url": "https://shop.example/invented"},
        {"component": "18650 cell", "search_query": "18650 protected cell & holder", "recommended_sites": "lcsc"},
    ],
}


class FakeClient:
    name = "fake"

    def __init__(self, design=DESIGN, sourcing=SOURCING):
        self.replies = {InferredDesign: design, SourcingPlan: sourcing}
        self.calls = []

    def analyze(self, images, system_prompt, response_schema, user_prompt=""):
        self.calls.append((response_schema, system_prompt, user_prompt, images))
        return json.dumps(self.replies[response_schema])


def bom() -> RobotBOM:
    return RobotBOM(
        project_name="rover", image_ids=["img1"],
        components=[observed("wheel-1", "wheel", "rubber wheel", 4), hidden("motor-1", "motor", "drive motor"),
                    observed("led-1", "led", "LED", 3, status="rejected")],
        issues=[
            ReviewIssue(id="drivetrain.unknown", severity="critical", message="no motor count", next_action="look",
                        component_ids=["wheel-1", "motor-1"]),
            ReviewIssue(id="done.1", severity="warning", message="already handled", next_action="-", resolved=True),
        ],
    )


def test_two_queries_run_in_order_and_the_bom_is_not_touched():
    client, project = FakeClient(), bom()
    before = project.model_dump()

    result = infer_and_source(client, project, model="some-model")

    assert [call[0] for call in client.calls] == [InferredDesign, SourcingPlan]
    assert all(call[3] == [] for call in client.calls)  # text-only: no photos are re-sent
    design_prompt = client.calls[0][2]
    assert "drivetrain.unknown" in design_prompt and "rubber wheel" in design_prompt
    assert "done.1" not in design_prompt and '"LED"' not in design_prompt  # resolved issue, rejected part
    assert "Approved parts-research sources" in client.calls[1][1] and "amazon" in client.calls[1][1]
    assert "DC gear motor" in client.calls[1][2]  # query 2 sources the list query 1 returned
    assert project.model_dump() == before and project.ready_to_purchase is False

    design = result["inferred_components"]
    assert design["generated_by"] == "some-model" and "not verified" in design["disclaimer"]
    assert design["design_choices"][0]["choice"] == "2 rear gear motors"
    assert [(c["name"], c["quantity"], c["basis"]) for c in design["components"]] == [
        ("rubber wheel", 4, "observed"), ("DC gear motor", 2, "inferred"), ("18650 cell", 2, "inferred")]
    motor = design["components"][1]
    assert motor["specs"] == {"voltage_v": "6"} and set(motor) == {"name", "category", "quantity", "specs", "basis", "reason"}
    assert design["components"][2]["category"] == "other"


def test_shop_links_are_built_by_the_app_never_taken_from_the_model():
    order = infer_and_source(FakeClient(), bom(), model="m")["order_links"]

    assert list(order["sites"]) == ["lcsc", "digikey", "rs", "sparkfun", "mouser", "amazon"]
    assert order["sites"]["amazon"] == {"name": "Amazon.com", "url": "https://www.amazon.com/"}
    assert "Search links only" in order["disclaimer"] and order["power_budget"].startswith("6 V")
    wheel, motor, cell = order["components"]

    assert motor["search_query"] == "TT gear motor 6V 1:48"  # the model's URL and markup are stripped
    assert motor["recommended_sites"] == ["amazon", "sparkfun"]  # unknown shop and duplicate dropped
    assert motor["links"]["amazon"] == "https://www.amazon.com/s?k=TT+gear+motor+6V+1%3A48"
    assert motor["links"]["lcsc"] == "https://www.lcsc.com/search?q=TT+gear+motor+6V+1%3A48"
    assert cell["links"]["mouser"] == "https://www.mouser.co.uk/c/?q=18650+protected+cell+%26+holder"
    assert cell["recommended_sites"] == []  # not a list -> ignored
    # no search suggested for the wheel: fall back to its name, still on every shop
    assert wheel["search_query"] == "rubber wheel" and set(wheel["links"]) == set(SHOPS)
    text = json.dumps(order)
    assert "example" not in text and "INVENTED" not in text
    for row in order["components"]:
        for key, url in row["links"].items():
            assert url.startswith(SHOPS[key][2])


def test_query_cleaning_and_link_encoding():
    assert clean_query("  L298N\n motor   driver\t") == "L298N motor driver"
    assert len(clean_query("x" * 500)) == 120
    assert shop_links("a b/c")["digikey"] == "https://www.digikey.co.uk/en/products/result?keywords=a+b%2Fc"
    assert shop_links("a b")["rs"] == "https://uk.rs-online.com/web/c/?searchTerm=a+b"
    assert shop_links("a b")["sparkfun"] == "https://www.sparkfun.com/catalogsearch/result/?q=a+b"


def test_a_reply_without_components_is_rejected_after_retries():
    client = FakeClient(design={"design_choices": [], "components": []})
    with pytest.raises(VisionResponseError):
        infer_and_source(client, bom(), model="m", max_retries=1)
    assert len(client.calls) == 2  # first try + one retry, and the sourcing query never runs


# ---- API and CLI, offline against the mock client --------------------------


@pytest.fixture
def http(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "load_settings", lambda: Settings())
    monkeypatch.setattr(cli, "load_settings", lambda: Settings())
    monkeypatch.setattr(api, "OUTPUT_ROOT", tmp_path / "web")
    return TestClient(api.app)


def test_api_infer_returns_both_documents_and_saves_them(http, tmp_path):
    analysed = http.post("/analyze", files=[("images", ("top.png", png_bytes(), "image/png"))],
                         data={"mock": "true"}).json()

    response = http.post("/infer", json={"review": analysed["review"], "job_id": analysed["job_id"]})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["inferred_components"]["components"] and "MOCK DATA" in body["inferred_components"]["summary"]
    assert body["order_links"]["components"][0]["links"]["amazon"].startswith("https://www.amazon.com/s?k=")
    saved = tmp_path / "web" / analysed["job_id"] / "inferred"
    assert json.loads((saved / "order_links.json").read_text(encoding="utf-8")) == body["order_links"]
    assert (saved / "inferred_components.json").is_file()


def test_api_infer_rejects_bad_input_and_needs_a_key_for_live_data(http):
    assert http.post("/infer", json={}).status_code == 422
    assert http.post("/infer", json={"review": {"bom": {}}}).status_code == 422
    live = analyze(make_images("top.png"), MockVisionClient(), project_name="rover", mode="live")
    review = live.review.model_dump(mode="json")
    assert http.post("/infer", json={"review": review, "model": "bad id!"}).status_code == 400
    no_key = http.post("/infer", json={"review": review})
    assert no_key.status_code == 503 and "No vision API key is configured" in no_key.json()["detail"]


def test_cli_infer_writes_both_files(http, tmp_path, capsys):
    photo = tmp_path / "top.png"
    photo.write_bytes(png_bytes())
    out = tmp_path / "out"
    assert cli.main(["analyze", str(photo), "--mock", "--out", str(out)]) == 0
    capsys.readouterr()

    assert cli.main(["infer", str(out / "review.json"), "--out", str(out / "inferred")]) == 0

    printed = capsys.readouterr().out
    assert "assumptions, not verified" in printed and "2 x DC gear motor [inferred]" in printed
    links = json.loads((out / "inferred" / "order_links.json").read_text(encoding="utf-8"))
    assert set(links["components"][0]["links"]) == set(SHOPS)
    assert (out / "inferred" / "inferred_components.json").is_file()
