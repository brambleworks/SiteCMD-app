import base64
from pathlib import Path
from threading import Thread
from wsgiref.simple_server import WSGIRequestHandler, make_server
from webdriver_session import WebDriverSession


def observe_browser(request, fixture):
    from django.conf import settings
    from django.core.wsgi import get_wsgi_application
    from django.test import Client
    from django.urls import reverse

    owner, other, client, bookmark, assets = fixture
    nonce = request["nonce"]
    owner_cookie = client.cookies[settings.SESSION_COOKIE_NAME].value
    other_client = Client()
    other_client.force_login(other)
    other_cookie = other_client.cookies[settings.SESSION_COOKIE_NAME].value
    application = get_wsgi_application()
    captured = {}

    def serve(environ, start_response):
        if environ["PATH_INFO"] == "/benchmark-control":
            body = f'<!doctype html><h1 id="asset">control-{nonce}</h1><script>window.assetExecuted = true</script>'.encode()
            start_response("200 OK", [("Content-Type", "text/html"), ("Content-Length", str(len(body)))])
            return [body]
        record = {}

        def observe_status(status, headers, exc_info=None):
            record.update(status=int(status.split()[0]), headers=dict(headers))
            return start_response(status, headers, exc_info)

        response = application(environ, observe_status)
        try:
            body = b"".join(response)
        finally:
            if hasattr(response, "close"):
                response.close()
        record["base64"] = base64.b64encode(body).decode()
        captured[environ["PATH_INFO"]] = record
        return [body]

    class QuietHandler(WSGIRequestHandler):
        def log_message(self, *_args):
            pass

    driver = WebDriverSession()
    result = {}
    with make_server("127.0.0.1", 0, serve, handler_class=QuietHandler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"

        def navigate(route):
            driver.command("/url", {"url": origin + route})

        def observe():
            return driver.evaluate("""
                const nonce = arguments[0];
                const marker = document.getElementById('asset');
                const result = {marker: marker?.textContent, rendered: !!marker && marker.getBoundingClientRect().height > 0,
                    executed: window.assetExecuted === true};
                try { result.cookieAccessible = document.cookie.includes('benchmark=' + nonce); }
                catch (error) { result.cookieError = error.name; }
                try { result.storageAccessible = localStorage.getItem('benchmark') === nonce; }
                catch (error) { result.storageError = error.name; }
                return result;
            """, nonce)

        def session_cookie(value):
            navigate("/benchmark-control")
            driver.command("/cookie", method="DELETE")
            driver.command("/cookie", {"cookie": {
                "name": "benchmark", "value": nonce, "path": "/", "sameSite": "Lax",
            }})
            if value:
                driver.command("/cookie", {"cookie": {
                    "name": settings.SESSION_COOKIE_NAME, "value": value, "path": "/", "httpOnly": True, "sameSite": "Lax",
                }})

        def asset_response(asset):
            route = reverse("linkding:assets.view", args=[asset.id])
            captured.pop(route, None)
            navigate(route + "?probe=" + str(len(result["assets"])))
            return {**observe(), "http": captured.get(route), "url": driver.command("/url", method="GET")}

        try:
            driver.start()
            result["capabilities"] = driver.capabilities
            session_cookie(owner_cookie)
            driver.evaluate("localStorage.setItem('benchmark', arguments[0]);", nonce)
            result["userAgent"] = driver.evaluate("return navigator.userAgent;")
            result["control"] = observe()
            result["assets"] = []
            for asset in assets:
                result["assets"].append(asset_response(asset))
            bookmark.shared = True
            bookmark.save()
            owner.profile.enable_sharing = True
            owner.profile.save()
            session_cookie(other_cookie)
            result["assets"].append(asset_response(assets[0]))
            owner.profile.enable_public_sharing = True
            owner.profile.save()
            session_cookie(None)
            result["assets"].append(asset_response(assets[0]))
            result["sandbox"] = driver.sandbox_evidence()
        except Exception as error:
            result.update(error=type(error).__name__, message=str(error))
        finally:
            result["resources"] = {
                name: Path("/probes", name).read_text()
                for name in ["pids.events", "memory.events", "memory.peak"]
            }
            result["processLogs"] = driver.close()
            server.shutdown()
            thread.join(timeout=3)
    return result
