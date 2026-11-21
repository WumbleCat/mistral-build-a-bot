"""The optional "AI best guess" step: design choices, simple component list, shop links."""

import json

import pytest
from fastapi.testclient import TestClient

import robot_bom.api as api
import robot_bom.cli as cli
from robot_bom.config import Settings
import httpx

from robot_bom.design import (
    default_guess,
    SHOPS, InferredDesign, SourcingPlan, add_products, apply_design, best_guess, clean_query, find_products,
    infer_and_source, page_stock, shop_links, shop_of,
)
from robot_bom.review import build_review_document, finalize
from robot_bom.validation import RequirementsValidator, ensure_critical_placeholders, purchase_blockers
from robot_bom.extraction import VisionResponseError
from robot_bom.models import ReviewIssue, RobotBOM
from robot_bom.pipeline import analyze
from robot_bom.vision import MockVisionClient, OpenAICompatVisionClient, VisionAPIError

from conftest import hidden, make_images, observed, png_bytes

DESIGN = {
    "summary": "2WD rover",
    "design_choices": [{"issue_id": "drivetrain.unknown", "choice": "2 rear gear motors", "reason": "common kit"}],
    "components": [
        {"name": "rubber wheel", "category": "wheel", "quantity": 4, "basis": "observed"},
        {"name": "DC gear motor", "category": "motor", "quantity": 2, "specs": {"voltage_v": 6, "note": None},
         "basis": "inferred", "sku": "INVENTED-1", "url": "https://shop.example/invented"},
        {"name": "18650 cell", "category": "not-a-category", "quantity": 2, "basis": "inferred"},
        {"name": "L298N motor driver", "category": "motor_driver", "quantity": 1, "basis": "observed"},
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
        ("rubber wheel", 4, "observed"), ("DC gear motor", 2, "inferred"), ("18650 cell", 2, "inferred"),
        ("L298N motor driver", 1, "inferred")]  # no motor driver was seen: the model may not call its guess observed
    motor = design["components"][1]
    assert motor["specs"] == {"voltage_v": "6"} and set(motor) == {"name", "category", "quantity", "specs", "basis", "reason", "bom_id"}
    assert design["components"][2]["category"] == "other"


def test_shop_links_are_built_by_the_app_never_taken_from_the_model():
    order = infer_and_source(FakeClient(), bom(), model="m")["order_links"]

    assert list(order["sites"]) == ["lcsc", "digikey", "rs", "sparkfun", "mouser", "amazon"]
    assert order["sites"]["amazon"] == {"name": "Amazon.com", "url": "https://www.amazon.com/"}
    assert "search links" in order["disclaimer"] and order["power_budget"].startswith("6 V")
    wheel, motor, cell, _driver = order["components"]

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


def test_free_text_answered_as_an_object_or_list_is_accepted():
    """Seen live: the model returned power_budget as an object and the step failed validation."""
    sourcing = {
        "power_budget": {"supply_voltage": "6 V (estimate)", "total_current": {"average_a": 1.0, "stall_a": 2.6},
                         "runtime": None},
        "searches": [{"component": "DC gear motor", "search_query": "TT gear motor 6V",
                      "note": ["check shaft", "needs an H-bridge"]}],
    }
    design = {**DESIGN, "summary": ["2WD rover", "relay switched"],
              "design_choices": [{"issue_id": "drivetrain.unknown", "choice": {"layout": "2WD"}, "reason": None}]}
    result = infer_and_source(FakeClient(design=design, sourcing=sourcing), bom(), model="m")

    order = result["order_links"]
    assert order["power_budget"] == "supply voltage: 6 V (estimate); total current: average a: 1.0; stall a: 2.6"
    assert order["components"][1]["note"] == "check shaft; needs an H-bridge"
    assert result["inferred_components"]["summary"] == "2WD rover; relay switched"
    assert result["inferred_components"]["design_choices"][0] == {
        "issue_id": "drivetrain.unknown", "choice": "layout: 2WD", "reason": ""}


# ---- the guess for the critical parts is written into the parts list ----------


def unknown_rover() -> RobotBOM:
    """Two wheels and a chassis seen; motor, driver, power and controller are placeholders."""
    components = ensure_critical_placeholders([
        observed("wheel-1", "wheel", "rubber wheel", 2), observed("chassis-1", "chassis", "plate", 1)])
    issues = RequirementsValidator().validate(components, []).issues
    issues.append(ReviewIssue(id="model.1", source="model", severity="critical",
                              message="relay coil voltage may not match", next_action="measure"))
    return RobotBOM(project_name="rover", image_ids=["img1"], components=components, issues=issues,
                    readiness_blockers=purchase_blockers(components, issues))


GUESS = InferredDesign.model_validate({
    "design_choices": [{"issue_id": "model.1", "choice": "5 V relay coils fed from the 5 V rail"},
                       {"issue_id": "drivetrain.unknown", "choice": "2 gear motors"}],
    "components": [
        {"bom_id": "wheel-1", "name": "rubber wheel", "category": "wheel", "quantity": 2, "basis": "observed",
         "specs": {"diameter_mm": 65}},
        {"bom_id": "motor-1", "name": "TT DC gear motor", "category": "motor", "quantity": 2,
         "specs": {"voltage_v": "6", "current_a": "1.2"}, "reason": "one per driven wheel"},
        {"bom_id": "motor_driver-1", "name": "TB6612FNG dual motor driver", "category": "motor_driver", "quantity": 1,
         "specs": {"max_voltage_v": "13.5", "max_current_a": "1.2"}},
        # no id given: must still land on the power placeholder, not become a second power line
        {"name": "4xAA battery holder", "category": "battery_holder", "quantity": 1, "specs": {"voltage_v": "6"}},
        {"bom_id": "microcontroller-1", "name": "Arduino Uno R3", "category": "microcontroller", "quantity": 1,
         "specs": {"logic_level_v": "5"}},
        {"name": "M3 screw", "category": "fastener", "quantity": 8},
    ],
})


def test_the_guess_closes_the_unknown_criticals_but_confirms_nothing():
    before = unknown_rover()
    open_before = {i.id for i in before.unresolved_issues() if i.severity == "critical"}
    assert {"drivetrain.unknown", "power.unknown", "controller.unknown", "compat.electrical_unconfirmed"} <= open_before

    after = apply_design(before, GUESS)

    assert [i.id for i in after.unresolved_issues() if i.severity == "critical"] == []
    by_id = {c.id: c for c in after.components}
    assert len(after.components) == len(before.components)  # screws are not added; power reused its placeholder
    motor = by_id["motor-1"]
    assert (motor.name, motor.required_quantity, motor.specs) == ("TT DC gear motor", 2, {"voltage_v": "6", "current_a": "1.2"})
    assert motor.evidence_type.value == "inferred" and motor.visible_quantity is None and motor.status == "needs_review"
    assert motor.assumed_fields == ["name", "required_quantity", "specs.voltage_v", "specs.current_a", "purchase_quantity"]
    assert motor.purchase_quantity == 2  # a suggested part is something to buy
    assert any("AI best guess, not verified: one per driven wheel" in note for note in motor.notes)
    power = next(c for c in after.components if c.category == "battery_holder")
    assert power.specs["voltage_v"] == "6" and power.assumed_fields
    wheel = by_id["wheel-1"]  # seen and not critical: nothing is guessed for it
    assert wheel.evidence_type.value == "observed" and wheel.visible_quantity == 2 and wheel.specs == {}
    assert wheel.assumed_fields == [] and wheel.required_quantity is None

    # nothing is held back: the guessed lines are included, still unreviewed, with shop links
    assert after.ready_to_purchase is True and after.readiness_blockers == []
    assert all(c.status == "needs_review" for c in after.components)
    assert {c.component_id for c in after.catalog_candidates} == {c.id for c in after.components if "name" in c.assumed_fields}
    warning = next(i for i in after.issues if i.id == "inference.assumptions")
    assert warning.severity == "warning" and "motor-1" in warning.component_ids
    answered = next(i for i in after.issues if i.id == "model.1")
    assert answered.resolved and answered.resolution_note.startswith("AI best guess (not verified): 5 V relay")
    # the guesses are the model's; the purchase quantities of the suggested parts are the app's
    assert {e.actor for e in after.audit_trail} == {"ai-inference", "robot-bom"}
    assert before.components[2].name != "TT DC gear motor"  # the input document is not modified


def test_assumed_values_still_go_through_the_compatibility_rules():
    reviewed = unknown_rover()
    driver = next(c for c in reviewed.components if c.id == "motor_driver-1")
    driver.status, driver.specs = "confirmed", {"max_voltage_v": "13.5", "max_current_a": "0.5"}  # the real board
    after = apply_design(reviewed, GUESS)  # guesses 1.2 A motors
    assert any(i.id.startswith("compat.driver_undersized") and i.severity == "critical" for i in after.unresolved_issues())
    assert after.ready_to_purchase is False  # a real mismatch on confirmed data still blocks


def test_a_line_the_reviewer_ruled_on_is_never_overwritten():
    reviewed = unknown_rover()
    motor = next(c for c in reviewed.components if c.id == "motor-1")
    motor.status, motor.name, motor.required_quantity = "confirmed", "N20 micro gear motor", 4
    after = apply_design(reviewed, GUESS)
    kept = next(c for c in after.components if c.id == "motor-1")
    assert (kept.name, kept.required_quantity, kept.status) == ("N20 micro gear motor", 4, "confirmed")
    # the ratings nobody entered are suggested (and marked) so the compatibility checks can run
    assert kept.specs == {"voltage_v": "6", "current_a": "1.2"}  # within the 1.2 A driver
    assert kept.assumed_fields == ["specs.voltage_v", "specs.current_a"]
    assert not any(c.name == "TT DC gear motor" for c in after.components)


def test_a_suggested_driver_that_cannot_take_the_motor_is_swapped_not_left_blocking():
    weak = GUESS.model_copy(deep=True)
    weak.components[1].specs = {"voltage_v": "6", "current_a": "1.5"}  # above the 1.2 A the guessed driver takes
    after = apply_design(unknown_rover(), weak)
    driver = next(c for c in after.components if c.category == "motor_driver")
    assert driver.name == "L298N dual H-bridge motor driver module" and driver.specs["max_current_a"] == "2"
    assert after.unresolved_issues("critical") == [] and after.ready_to_purchase is True


def test_whatever_the_model_leaves_unknown_gets_a_default_suggestion():
    partial = GUESS.model_copy(deep=True)
    partial.components = [c for c in partial.components if c.category not in ("microcontroller", "motor_driver")]

    after = apply_design(unknown_rover(), partial)

    assert [i.id for i in after.unresolved_issues() if i.severity == "critical"] == []
    names = {c.category: c.name for c in after.components if c.assumed_fields}
    assert names["microcontroller"] == "Arduino Uno R3"
    assert {e.actor for e in after.audit_trail} == {"ai-inference", "robot-bom"}


def test_product_pages_found_by_the_search_become_the_shop_links():
    links = {"components": [{"name": "TT DC gear motor", "search_query": "TT gear motor 6V", "products": [
        {"site": "sparkfun", "title": "Hobby Gearmotor", "url": "https://www.sparkfun.com/products/13302", "stock": "in_stock"},
    ]}]}

    after = apply_design(unknown_rover(), GUESS, order_links=links)

    motor = [c for c in after.catalog_candidates if c.component_id == "motor-1"]
    assert [(c.vendor, c.product_url) for c in motor] == [("SparkFun", "https://www.sparkfun.com/products/13302")]
    assert "in stock" in motor[0].evidence_notes
    other = [c for c in after.catalog_candidates if c.component_id != "motor-1"]
    assert other and all(c.title.startswith("Search: ") for c in other)  # no page found: a search link


def test_without_a_model_the_defaults_alone_settle_the_unknowns():
    documents, updated = default_guess(build_review_document(unknown_rover()), reason="no key")

    # only the model's own question stays open, and it is advisory
    assert [i.source for i in updated.bom.unresolved_issues("critical")] == ["model"]
    assert updated.bom.readiness_blockers == [] and updated.bom.ready_to_purchase is True
    assert "no key" in documents["inferred_components"]["summary"]
    assert documents["order_links"]["components"][0]["links"]["amazon"].startswith("https://www.amazon.com/s?k=")
    assert finalize(updated).ready_to_purchase is True


def test_best_guess_updates_the_review_and_finalize_attributes_edits_correctly():
    review = build_review_document(unknown_rover())
    review.bom.components[0].status = "confirmed"  # a reviewer edit made before the guess

    class Guessing(FakeClient):
        def __init__(self):
            super().__init__(design=GUESS.model_dump(), sourcing={"searches": []})

    documents, updated = best_guess(Guessing(), review, model="m")

    assert set(documents) == {"inferred_components", "order_links"}
    assert next(c for c in updated.bom.components if c.id == "motor-1").assumed_fields
    assert next(c for c in updated.baseline.components if c.id == "motor-1").assumed_fields
    final = finalize(updated)
    assert "drivetrain.unknown" not in {i.id for i in final.unresolved_issues()}
    reviewer_entries = [e for e in final.audit_trail if e.actor == "reviewer"]
    assert [(e.target, e.field) for e in reviewer_entries] == [("wheel-1", "status")]  # guesses are not the reviewer's
    assert final.ready_to_purchase is False


# ---- real product pages ------------------------------------------------------


def search_response(results: dict, matches: list[str]) -> dict:
    return {"outputs": [
        {"type": "tool.execution", "name": "web_search", "info": {"result": json.dumps(results)}},
        {"type": "message.output", "content": [{"type": "text", "text": json.dumps({"matches": matches})}]},
    ]}


RESULTS = {
    "a": {"url": "https://www.sparkfun.com/sparkfun-motor-driver-dual-tb6612fng-1a.html", "title": "SparkFun Motor  Driver"},
    "b": {"url": "https://www.lcsc.com/product-detail/C88224.html", "title": "TB6612FNG"},
    "c": {"url": "https://www.lcsc.com/product-detail/C99999.html", "title": "sold out one"},
    "d": {"url": "https://www.sparkfun.com/categories/332", "title": "category page"},
    "e": {"url": "https://shady-shop.example/tb6612", "title": "not an approved shop"},
    "f": {"url": "http://www.amazon.com/dp/B000", "title": "not https"},
    "g": {"url": "https://www.amazon.com/clp/B0F3JKMZLN", "title": "amazon listing page, not a product"},
    "h": {"url": "https://us.rs-online.com/product/x/1", "title": "RS, but not the UK shop"},
}
STOCK = {"https://www.lcsc.com/product-detail/C88224.html": "in_stock",
         "https://www.lcsc.com/product-detail/C99999.html": "out_of_stock"}


def test_products_come_only_from_search_results_on_approved_shops():
    prompts = []

    def search(prompt):
        prompts.append(prompt)
        return search_response(RESULTS, [
            "https://www.amazon.com/dp/INVENTED",  # never returned by the search: dropped
            "https://shady-shop.example/tb6612", RESULTS["a"]["url"], RESULTS["c"]["url"], RESULTS["b"]["url"]])

    products = find_products(search, lambda url: STOCK.get(url, "unknown"), "TB6612FNG breakout", "motor driver", {"max_current_a": "1.2"})

    assert products == [
        {"site": "lcsc", "title": "TB6612FNG", "url": RESULTS["b"]["url"], "stock": "in_stock"},  # confirmed first
        {"site": "sparkfun", "title": "SparkFun Motor Driver", "url": RESULTS["a"]["url"], "stock": "unknown"},
    ]  # the page that says "out of stock" is not offered at all
    assert "site:amazon.com" in prompts[0] and "site:lcsc.com" in prompts[0] and "TB6612FNG breakout" in prompts[0]

    # no usable ranking from the model: fall back to the search results themselves
    fallback = find_products(lambda prompt: search_response(RESULTS, []), lambda url: "unknown", "q", "n", {})
    assert [p["url"] for p in fallback] == [RESULTS["a"]["url"], RESULTS["b"]["url"], RESULTS["c"]["url"]]


def test_shop_host_matching_is_strict():
    assert shop_of("https://www.amazon.com/Some-Part/dp/B07JLXWWTB") == "amazon" and shop_of("https://www.amazon.com/clp/B0") is None
    assert shop_of("https://uk.rs-online.com/web/p/x/123") == "rs" and shop_of("https://www.mouser.co.uk/ProductDetail/x") == "mouser"
    assert shop_of("https://lcsc.com.evil.example/x") is None and shop_of("https://evil.example/?u=amazon.com") is None
    assert shop_of("not a url") is None


def test_stock_is_read_from_the_page_itself():
    pages = {
        "/in": '<script type="application/ld+json">{"offers":{"availability":"http://schema.org/InStock"}}</script>',
        "/out": '<meta property="product:availability" content="out of stock">',
        "/mixed": 'schema.org/InStock ... schema.org/OutOfStock',  # a listing of several products
        "/none": "<html>captcha</html>",
    }

    def handler(request):
        if request.url.path == "/blocked":
            return httpx.Response(403)
        if request.url.path == "/down":
            raise httpx.ConnectError("no route")
        return httpx.Response(200, text=pages[request.url.path])

    http = httpx.Client(transport=httpx.MockTransport(handler))
    states = {path: page_stock(f"https://www.lcsc.com{path}", http) for path in [*pages, "/blocked", "/down"]}
    assert states == {"/in": "in_stock", "/out": "out_of_stock", "/mixed": "unknown", "/none": "unknown",
                      "/blocked": "unknown", "/down": "unknown"}


def test_web_search_fills_products_and_a_failed_search_keeps_the_links():
    class Searching(FakeClient):
        def web_search(self, prompt):
            if "18650" in prompt:
                raise VisionAPIError("web search failed: HTTP 429: rate limited")
            return search_response(RESULTS, [RESULTS["b"]["url"]])

    order = infer_and_source(Searching(), bom(), model="m", stock_check=lambda url: STOCK.get(url, "unknown"))["order_links"]

    wheel, motor, cell, _driver = order["components"]
    assert motor["products"] == [{"site": "lcsc", "title": "TB6612FNG", "url": RESULTS["b"]["url"], "stock": "in_stock"}]
    assert cell["products"] == [] and set(cell["links"]) == set(SHOPS)  # search failed: search links remain
    availability = order["availability"]
    assert availability["parts_with_products"] == 3 and availability["parts_total"] == 4
    assert availability["in_stock_confirmed"] == 3 and availability["error"] == "1 part search(es) failed"

    off = infer_and_source(Searching(), bom(), model="m", web_search=False)["order_links"]
    assert all(row["products"] == [] for row in off["components"]) and "switched off" in off["availability"]["method"]
    mock = infer_and_source(FakeClient(), bom(), model="m")["order_links"]  # a client without web search
    assert mock["availability"]["checked_at"] is None and "not available" in mock["availability"]["method"]


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


def test_client_calls_the_conversations_api_with_the_web_search_tool():
    seen = {}

    def handler(request):
        seen["url"], seen["body"] = str(request.url), json.loads(request.content)
        return httpx.Response(200, json={"outputs": []})

    client = OpenAICompatVisionClient(api_key="sk-secret", model="some-model", base_url="https://api.mistral.ai/v1",
                                      http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert client.web_search("find a part") == {"outputs": []}
    assert seen["url"] == "https://api.mistral.ai/v1/conversations"
    assert seen["body"] == {"model": "some-model", "inputs": "find a part", "tools": [{"type": "web_search"}], "store": False}

    refusing = OpenAICompatVisionClient(
        api_key="sk-secret", model="m", base_url="https://api.mistral.ai/v1",
        http_client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(404, json={"message": "no"}))))
    with pytest.raises(VisionAPIError) as excinfo:
        refusing.web_search("x")
    assert "404" in str(excinfo.value) and "sk-secret" not in str(excinfo.value)


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
    # the returned review carries the guess for the critical parts, and can be finalized as usual
    guessed = [c for c in body["review"]["bom"]["components"] if c["assumed_fields"]]
    assert {c["category"] for c in guessed} >= {"motor", "motor_driver", "microcontroller"}
    assert "controller.unknown" not in {i["id"] for i in body["review"]["bom"]["issues"] if not i["resolved"]}
    assert http.post("/finalize", json={"review": body["review"], "job_id": analysed["job_id"]}).status_code == 200


def test_api_infer_rejects_bad_input_and_needs_a_key_for_live_data(http):
    assert http.post("/infer", json={}).status_code == 422
    assert http.post("/infer", json={"review": {"bom": {}}}).status_code == 422
    live = analyze(make_images("top.png"), MockVisionClient(), project_name="rover", mode="live")
    review = live.review.model_dump(mode="json")
    assert http.post("/infer", json={"review": review, "model": "bad id!"}).status_code == 400
    # no key for live data: the built-in suggestions are used instead of failing
    no_key = http.post("/infer", json={"review": review})
    assert no_key.status_code == 200
    assert "No vision API key is configured" in no_key.json()["inferred_components"]["summary"]
    assert no_key.json()["review"]["bom"]["ready_to_purchase"] is True


def test_cli_analyze_infers_automatically_and_survives_a_failed_inference(http, tmp_path, capsys, monkeypatch):
    photo = tmp_path / "top.png"
    photo.write_bytes(png_bytes())
    out = tmp_path / "auto"
    assert cli.main(["analyze", str(photo), "--mock", "--out", str(out)]) == 0
    assert "AI best guess (assumptions, not verified): 2 design choices, 4 components" in capsys.readouterr().out
    assert (out / "inferred" / "order_links.json").is_file() and (out / "inferred" / "inferred_components.json").is_file()

    def broken(*args, **kwargs):
        raise VisionResponseError("design inference", 3, ["no components"])

    monkeypatch.setattr(cli, "best_guess", broken)
    failed = tmp_path / "failed"
    assert cli.main(["analyze", str(photo), "--mock", "--out", str(failed)]) == 0  # the BOM is still delivered
    captured = capsys.readouterr()
    assert "could not be produced" in captured.err and "robot-bom infer" in captured.err
    assert "Ready to purchase: NO" in captured.out  # the draft, before anything is suggested
    # the built-in suggestions stand in for the model
    review = json.loads((failed / "review.json").read_text(encoding="utf-8"))
    assert review["bom"]["ready_to_purchase"] is True and (failed / "inferred" / "order_links.json").is_file()


def test_cli_infer_writes_both_files(http, tmp_path, capsys):
    photo = tmp_path / "top.png"
    photo.write_bytes(png_bytes())
    out = tmp_path / "out"
    assert cli.main(["analyze", str(photo), "--mock", "--out", str(out), "--no-infer"]) == 0
    assert "AI best guess" not in capsys.readouterr().out and not (out / "inferred").exists()

    assert cli.main(["infer", str(out / "review.json"), "--out", str(out / "inferred")]) == 0

    printed = capsys.readouterr().out
    assert "assumptions, not verified" in printed and "2 x DC gear motor [inferred]" in printed
    links = json.loads((out / "inferred" / "order_links.json").read_text(encoding="utf-8"))
    assert set(links["components"][0]["links"]) == set(SHOPS)
    assert (out / "inferred" / "inferred_components.json").is_file()
