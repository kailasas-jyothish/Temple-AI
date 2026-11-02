from fastapi.testclient import TestClient

from app import core
from app.main import app

client = TestClient(app)


def test_core_run():
    assert core.run("  om  ") == {"echo": "om", "length": 2}


def test_healthz_is_open_and_reports_problems():
    res = client.get("/healthz")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert isinstance(body["problems"], list)


def test_api_and_ui_work_without_password():
    assert client.post("/api/run", json={"text": "om"}).json()["echo"] == "om"
    assert client.get("/").status_code == 200


def test_empty_text_is_rejected():
    assert client.post("/api/run", json={"text": "  "}).status_code == 422
