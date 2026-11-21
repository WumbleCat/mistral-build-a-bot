"""HTTP adapters, exercised through httpx.MockTransport (no network). Covers spec test 7."""

import json

import httpx
import pytest

from robot_bom.catalog import HttpCatalogClient, NOT_CONFIGURED, NullCatalogClient, build_catalog_client, find_candidates
from robot_bom.config import Settings
from robot_bom.models import ImageObservation
from robot_bom.vision import MockVisionClient, OpenAICompatVisionClient, VisionAPIError, clients_for_run, describe_models

from conftest import hidden, make_images, observed

SECRET = "sk-test-do-not-leak-456"


def vision_client(handler, **kwargs) -> OpenAICompatVisionClient:
    return OpenAICompatVisionClient(
        api_key=SECRET, model="vision-model", base_url="https://api.mistral.ai/v1",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)), sleep=lambda _: None, **kwargs,
    )


def chat_reply(text: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": text}}]})


def test_request_shape_for_mistral_chat_completions():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return chat_reply('{"view": "top", "parts": []}')

    images = make_images("top.png")
    reply = vision_client(handler).analyze(images, "SYSTEM", ImageObservation, "USER")

    assert reply == '{"view": "top", "parts": []}'
    assert seen["url"] == "https://api.mistral.ai/v1/chat/completions"
    assert seen["auth"] == f"Bearer {SECRET}"
    body = seen["body"]
    assert body["model"] == "vision-model" and body["temperature"] == 0 and body["top_p"] == 1
    assert body["response_format"] == {"type": "json_object"}
    assert body["messages"][0] == {"role": "system", "content": "SYSTEM"}
    content = body["messages"][1]["content"]
    assert content[0] == {"type": "text", "text": "USER"}
    assert images[0].image_id in content[1]["text"]
    assert content[2]["type"] == "image_url"
    assert content[2]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_json_mode_can_be_disabled_for_other_providers():
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return chat_reply("{}")

    vision_client(handler, json_mode="none").analyze([], "s", ImageObservation, "u")
    assert "response_format" not in bodies[0]


def test_rejected_credentials_fail_clearly_without_leaking_the_key():
    def handler(request):
        return httpx.Response(401, json={"message": "Unauthorized"})

    with pytest.raises(VisionAPIError) as excinfo:
        vision_client(handler).analyze([], "s", ImageObservation, "u")
    message = str(excinfo.value)
    assert "rejected the configured credentials" in message and "MISTRAL_API_KEY" in message
    assert SECRET not in message


def test_transient_errors_are_retried_then_succeed():
    attempts = []

    def handler(request):
        attempts.append(1)
        return httpx.Response(503, text="busy") if len(attempts) < 3 else chat_reply("{}")

    assert vision_client(handler).analyze([], "s", ImageObservation, "u") == "{}"
    assert len(attempts) == 3


def test_transient_errors_are_bounded():
    attempts = []

    def handler(request):
        attempts.append(1)
        return httpx.Response(429, json={"message": "rate limited"})

    with pytest.raises(VisionAPIError, match="after 3 attempts.*429"):
        vision_client(handler).analyze([], "s", ImageObservation, "u")
    assert len(attempts) == 3


def test_network_failure_is_reported_without_the_key():
    def handler(request):
        raise httpx.ConnectError("connection refused")

    with pytest.raises(VisionAPIError) as excinfo:
        vision_client(handler).analyze([], "s", ImageObservation, "u")
    assert "network error" in str(excinfo.value) and SECRET not in str(excinfo.value)


def test_slow_reply_is_asked_for_once_more_then_reported_with_the_way_out():
    attempts = []

    def handler(request):
        attempts.append(1)
        raise httpx.ReadTimeout("The read operation timed out")

    with pytest.raises(VisionAPIError) as excinfo:
        vision_client(handler, timeout_s=300).analyze([], "s", ImageObservation, "u")
    message = str(excinfo.value)
    assert len(attempts) == 2  # not three: each retry restarts the whole generation
    assert "did not answer within 300s" in message and "VISION_TIMEOUT_S" in message
    assert "vision-model" in message and SECRET not in message


def test_one_slow_reply_does_not_fail_the_call():
    attempts = []

    def handler(request):
        attempts.append(1)
        if len(attempts) == 1:
            raise httpx.ReadTimeout("The read operation timed out")
        return chat_reply("{}")

    assert vision_client(handler).analyze([], "s", ImageObservation, "u") == "{}"


def test_default_wait_for_a_reply_is_long_and_connecting_is_not():
    client = OpenAICompatVisionClient(api_key=SECRET, model="m", base_url="https://api.mistral.ai/v1")
    timeout = client._client.timeout
    assert Settings().timeout_s == 300 and timeout.read == 300 and timeout.connect == 20


def test_unexpected_response_shape_is_an_api_error():
    with pytest.raises(VisionAPIError, match="unexpected response shape"):
        vision_client(lambda request: httpx.Response(200, json={"oops": True})).analyze([], "s", ImageObservation, "u")


# ---- model list -----------------------------------------------------------

MODEL_LISTING = {"object": "list", "data": [
    {"id": "text-only", "capabilities": {"completion_chat": True, "vision": False}},
    {"id": "embedder", "capabilities": {"completion_chat": False, "vision": False}},
    {"id": "big-latest", "name": "big-4", "aliases": ["big-4"], "capabilities": {"completion_chat": True, "vision": True}},
    {"id": "big-latest", "capabilities": {"completion_chat": True, "vision": True}},  # duplicate id
    {"id": "old", "deprecation": "2027-01-01", "capabilities": {"completion_chat": True, "vision": True}},
    {"id": "other-provider-model"},  # no capabilities reported
    {"id": "bad id <script>"}, "junk",
]}


def test_model_list_is_fetched_and_trimmed_for_the_picker():
    seen = {}

    def handler(request):
        seen["url"], seen["auth"] = str(request.url), request.headers["authorization"]
        return httpx.Response(200, json=MODEL_LISTING)

    models = describe_models(vision_client(handler).list_models())

    assert seen == {"url": "https://api.mistral.ai/v1/models", "auth": f"Bearer {SECRET}"}
    assert [m["id"] for m in models] == ["big-latest", "other-provider-model", "old", "text-only", "embedder"]
    by_id = {m["id"]: m for m in models}
    assert by_id["big-latest"] == {"id": "big-latest", "name": "big-4", "aliases": ["big-4"], "chat": True,
                                   "vision": True, "usable": True, "deprecated": False, "rank": 1}
    assert [m["rank"] for m in models] == [1, 2, 3, 4, 5]
    assert by_id["old"]["deprecated"] is True
    assert by_id["other-provider-model"]["usable"] is True and by_id["other-provider-model"]["vision"] is None
    assert not by_id["text-only"]["usable"] and not by_id["embedder"]["usable"]


def test_models_are_ranked_best_to_worst():
    caps = {"completion_chat": True, "vision": True}
    raw = [
        {"id": "mistral-small-latest", "capabilities": caps},
        {"id": "mistral-large-2512", "capabilities": caps},
        {"id": "ministral-8b-latest", "capabilities": caps},
        {"id": "mistral-medium-3-5", "capabilities": caps},
        {"id": "mistral-large-latest", "capabilities": caps},
        {"id": "mistral-large-4", "capabilities": caps},
        {"id": "ministral-14b-2512", "capabilities": caps},
        {"id": "mistral-medium-3", "capabilities": caps},
        {"id": "mistral-ocr-latest", "capabilities": {"completion_chat": False}},
    ]
    models = describe_models(raw)
    assert [m["id"] for m in models] == [
        "mistral-large-latest", "mistral-large-4", "mistral-large-2512",
        "mistral-medium-3-5", "mistral-medium-3",
        "mistral-small-latest",
        "ministral-14b-2512", "ministral-8b-latest",
        "mistral-ocr-latest",
    ]
    assert [m["rank"] for m in models] == list(range(1, len(models) + 1))
    assert models[-1]["usable"] is False


def test_model_list_failure_is_an_api_error_without_the_key():
    with pytest.raises(VisionAPIError) as excinfo:
        vision_client(lambda request: httpx.Response(401, json={"message": "Unauthorized"})).list_models()
    assert "401" in str(excinfo.value) and SECRET not in str(excinfo.value)


def test_a_chosen_model_is_used_for_every_pass():
    client = vision_client(lambda request: chat_reply("{}"))
    settings = Settings(vision_model="vision-model", reasoning_model="text-model")

    vision, reasoning, name = clients_for_run(client, settings)
    assert (vision._model, reasoning._model, name) == ("vision-model", "text-model", "vision-model")

    vision, reasoning, name = clients_for_run(client, settings, "picked")
    assert (vision._model, reasoning, name) == ("picked", None, "picked") and "(picked)" in vision.name
    assert client._model == "vision-model"  # the shared client is not modified

    mock = MockVisionClient()
    assert clients_for_run(mock, settings, "picked") == (mock, None, "mock")


# ---- catalog --------------------------------------------------------------


def test_unconfigured_catalog_returns_nothing():
    catalog = build_catalog_client(Settings())
    assert isinstance(catalog, NullCatalogClient)
    assert catalog.status == NOT_CONFIGURED
    assert find_candidates([observed("wheel-1", "wheel", "rubber wheel", 4)], catalog) == []


def catalog_client(records) -> HttpCatalogClient:
    def handler(request):
        assert request.url.params["q"]
        return httpx.Response(200, json={"results": records})

    return HttpCatalogClient("https://catalog.example.test/search",
                             http_client=httpx.Client(transport=httpx.MockTransport(handler)))


def test_catalog_candidates_are_kept_separate_and_never_auto_confirmed():
    wheel = observed("wheel-1", "wheel", "rubber wheel", 4)
    unseen_motor = hidden("motor-1", "motor", "DC gear motor")
    records = [
        {"title": "65mm rubber wheel for TT motor", "product_url": "https://shop.example.test/p/1",
         "vendor": "Example Shop", "sku": "W-65", "price": "2.50", "currency": "EUR"},
        {"title": "Wheel with no link"},                                      # no URL -> dropped
        {"title": "Relative link wheel", "product_url": "/p/3"},              # not absolute -> dropped
        {"title": "Unpriced rubber wheel", "product_url": "https://shop.example.test/p/4"},
    ]

    candidates = find_candidates([wheel, unseen_motor], catalog_client(records))

    assert {c.component_id for c in candidates} == {"wheel-1"}  # nobody shops for unseen, unconfirmed parts
    assert [c.product_url for c in candidates] == ["https://shop.example.test/p/1", "https://shop.example.test/p/4"]
    first, second = candidates
    assert (first.sku, first.price, first.currency, first.vendor) == ("W-65", 2.5, "EUR", "Example Shop")
    assert second.price is None and second.currency is None and second.sku is None
    assert all(c.compatible is None and c.queried_at and c.query == "rubber wheel" for c in candidates)
    assert "not verified against the physical part" in first.evidence_notes
    # the component itself is untouched by a search hit
    assert wheel.status == "needs_review" and wheel.sku is None


def test_reviewed_part_number_drives_the_query_and_ranking():
    wheel = observed("wheel-1", "wheel", "rubber wheel", 4, status="confirmed", sku="W-65", manufacturer="Acme")
    records = [
        {"title": "Some other wheel", "product_url": "https://shop.example.test/p/9", "sku": "W-99"},
        {"title": "Acme wheel", "product_url": "https://shop.example.test/p/1", "sku": "w-65"},
    ]
    candidates = find_candidates([wheel], catalog_client(records))
    assert candidates[0].sku == "w-65" and "Exact SKU match" in candidates[0].evidence_notes
    assert candidates[0].query == "Acme W-65"


def test_catalog_outage_yields_no_candidates():
    def handler(request):
        return httpx.Response(500)

    catalog = HttpCatalogClient("https://catalog.example.test/search",
                                http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert find_candidates([observed("wheel-1", "wheel", "rubber wheel", 4)], catalog) == []
    assert "failed" in catalog.status
