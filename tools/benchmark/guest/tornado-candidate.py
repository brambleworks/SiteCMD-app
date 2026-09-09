import asyncio
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, "/work")
request = json.load(sys.stdin)


async def observe():
    from tornado.httpserver import HTTPServer
    from tornado.netutil import bind_sockets
    from tornado.simple_httpclient import SimpleAsyncHTTPClient
    from tornado.web import Application

    root = Path("/tmp/sitecmd-static")
    (root / "dir").mkdir(parents=True)
    (root / "index.html").write_text(request["index"])
    (root / "dir/index.html").write_text(request["index"])
    (root / "dir/asset.txt").write_text(request["asset"])
    Path("/tmp/outside.txt").write_text("Private fixture data\n")
    app = Application(
        [],
        static_path=str(root),
        static_url_prefix="/",
        static_handler_args={"default_filename": "index.html"},
    )
    sockets = bind_sockets(0, address="127.0.0.1")
    port = sockets[0].getsockname()[1]
    server = HTTPServer(app)
    server.add_sockets(sockets)
    client = SimpleAsyncHTTPClient()
    responses = []
    try:
        for item in request["requests"]:
            response = await client.fetch(
                f"http://127.0.0.1:{port}{item['path']}",
                method=item.get("method", "GET"),
                headers={"Host": "sitecmd.example"},
                follow_redirects=False,
                raise_error=False,
                request_timeout=2,
            )
            responses.append({
                "status": response.code,
                "headers": {key.lower(): value for key, value in response.headers.items()},
                "body": response.body.decode("utf-8", errors="replace"),
            })
    finally:
        client.close()
        server.stop()
        await server.close_all_connections()
    return {"responses": responses}


try:
    if request["operation"] == "public-tests":
        result = subprocess.run(
            [sys.executable, "-B", "-m", "unittest",
             "tornado.test.web_test.StaticFileTest",
             "tornado.test.web_test.StaticDefaultFilenameTest",
             "tornado.test.web_test.StaticFileWithPathTest",
             "tornado.test.web_test.RedirectHandlerTest"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        output = {"exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
    elif request["operation"] == "http":
        output = asyncio.run(observe())
    else:
        raise ValueError("Unknown repository probe")
except Exception as error:
    output = {"error": type(error).__name__, "message": str(error)}
print(json.dumps(output))
