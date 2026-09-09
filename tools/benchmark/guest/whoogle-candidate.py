import contextlib
from datetime import datetime
import io
import json
import os
from pathlib import Path
import pickle
import shutil
import sys

request = json.load(sys.stdin)


def response_data(response):
    return {
        "status": response.status_code,
        "location": response.headers.get("Location"),
        "body": response.get_data(as_text=True),
    }


def observe():
    if request.get("operation") != "config-paths":
        raise ValueError("Unknown repository probe")
    static = Path("/tmp/whoogle-static")
    config = Path("/tmp/whoogle-config")
    shutil.copytree("/work/app/static", static)
    config.mkdir()
    (config / "bangs.json").write_text("{}", encoding="utf-8")
    os.environ.update({
        "STATIC_FOLDER": str(static),
        "CONFIG_VOLUME": str(config),
        "WHOOGLE_CONFIG_URL": "http://localhost/",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    sys.path.insert(0, "/work")

    from app import app
    from app.models.endpoint import Endpoint

    app.config["LAST_UPDATE_CHECK"] = datetime.now()
    app.config["CONFIG_DISABLE"] = 0
    app.config["TESTING"] = False
    endpoint = f"/{Endpoint.config}"
    client = app.test_client()
    with client.session_transaction() as session:
        session["uuid"] = "sitecmd-benchmark"
        session["key"] = app.enc_key
        session["config"] = {}
        session["auth"] = False

    outside_write = Path("/tmp/outside-write.pkl")
    absolute_write = Path("/tmp/outside-absolute.pkl")
    outside_read = Path("/tmp/outside-read.pkl")
    absolute_read = Path("/tmp/outside-read-absolute.pkl")
    for target in [outside_read, absolute_read]:
        with target.open("wb") as handle:
            pickle.dump({"url": "/loaded", "token": request["readMarker"]}, handle)

    def reset_session():
        with client.session_transaction() as session:
            session["config"] = {"url": "/safe", "token": "safe"}

    traversal_write = client.post(
        endpoint,
        query_string={"name": "../outside-write.pkl"},
        data={"url": "/traversal-write", "token": request["writeMarker"]},
    )
    reset_session()
    absolute_write_response = client.post(
        endpoint,
        query_string={"name": str(absolute_write)},
        data={"url": "/absolute-write", "token": request["writeMarker"]},
    )
    reset_session()
    traversal_read = client.put(endpoint, query_string={"name": "../outside-read.pkl"})
    reset_session()
    absolute_read_response = client.put(endpoint, query_string={"name": str(absolute_read)})
    invalid_names = []
    for name in ["nested/name", "bad name"]:
        reset_session()
        invalid_names.append(
            response_data(
                client.post(endpoint, query_string={"name": name}, data={"url": "/invalid"})
            )
        )

    unnamed_save = client.post(endpoint, data={"url": "/ordinary", "theme": "dark"})
    unnamed_get = client.get(endpoint)
    valid_name = "profile+1"
    named_save = client.post(
        endpoint,
        query_string={"name": valid_name},
        data={"url": "/named", "theme": "light"},
    )
    named_path = config / valid_name
    with client.session_transaction() as session:
        session["config"] = {"url": "/different", "theme": "system"}
    named_load = client.put(endpoint, query_string={"name": valid_name})
    app.config["CONFIG_DISABLE"] = 1
    disabled = client.post(endpoint, data={"url": "/disabled"})
    app.config["CONFIG_DISABLE"] = 0
    after_rejected = client.put(endpoint, query_string={"name": valid_name})

    return {
        "python": sys.version,
        "candidateModules": sorted(
            name
            for name, module in sys.modules.items()
            if getattr(module, "__file__", "").startswith("/work/")
        ),
        "security": {
            "traversalWrite": {
                "response": response_data(traversal_write),
                "outsideExists": outside_write.exists(),
            },
            "absoluteWrite": {
                "response": response_data(absolute_write_response),
                "outsideExists": absolute_write.exists(),
            },
            "traversalRead": response_data(traversal_read),
            "absoluteRead": response_data(absolute_read_response),
            "invalidNames": invalid_names,
        },
        "ordinary": {
            "unnamedSave": response_data(unnamed_save),
            "unnamedGet": response_data(unnamed_get),
            "namedSave": {
                "response": response_data(named_save),
                "insideExists": named_path.is_file(),
            },
            "namedLoad": response_data(named_load),
            "disabled": response_data(disabled),
            "afterRejected": response_data(after_rejected),
        },
    }


logs = io.StringIO()
try:
    with contextlib.redirect_stdout(logs), contextlib.redirect_stderr(logs):
        output = observe()
except Exception as error:
    output = {"error": type(error).__name__, "message": str(error)}
output["logs"] = logs.getvalue()
print(json.dumps(output))
