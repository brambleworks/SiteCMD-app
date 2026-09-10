import base64
import contextlib
import gzip
import io
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, "/work")
request = json.load(sys.stdin)


def configure():
    os.environ["DJANGO_SETTINGS_MODULE"] = "bookmarks.settings.dev"
    from django.conf import settings

    settings.DATABASES["default"]["NAME"] = "/tmp/browser.sqlite3" if request["operation"] == "browser" else ":memory:"
    settings.LD_ASSET_FOLDER = "/tmp/assets"
    settings.LD_FAVICON_FOLDER = "/tmp/favicons"
    settings.LD_PREVIEW_FOLDER = "/tmp/previews"
    settings.HUEY["filename"] = "/tmp/tasks.sqlite3"
    settings.STATICFILES_DIRS = ["/work/bookmarks/styles"]
    for folder in [settings.LD_ASSET_FOLDER, settings.LD_FAVICON_FOLDER, settings.LD_PREVIEW_FOLDER]:
        Path(folder).mkdir()
    import django

    django.setup()


def create_assets():
    from django.contrib.auth.models import User
    from django.core.management import call_command
    from django.test import Client
    from django.utils import timezone
    from bookmarks.models import Bookmark, BookmarkAsset

    call_command("migrate", verbosity=0, interactive=False)
    owner = User.objects.create_user(username="owner")
    other = User.objects.create_user(username="other")
    client = Client()
    client.force_login(owner)
    bookmark = Bookmark.objects.create(
        url="https://example.invalid/saved", owner=owner,
        date_added=timezone.now(), date_modified=timezone.now(),
    )
    assets = []

    for index, item in enumerate(request["assets"]):
        data = base64.b64decode(item["base64"], validate=True)
        filename = f"asset-{index}"
        Path("/tmp/assets", filename).write_bytes(gzip.compress(data) if item["gzip"] else data)
        asset = BookmarkAsset.objects.create(
            bookmark=bookmark, file=filename, asset_type=item["type"],
            content_type=item["contentType"], gzip=item["gzip"],
            display_name=item["filename"][:-5] if item["type"] == "snapshot" else item["filename"],
            status=BookmarkAsset.STATUS_COMPLETE,
        )
        assets.append(asset)
    return owner, other, client, bookmark, assets


def observe_assets():
    from django.urls import reverse

    owner, other, client, bookmark, assets = create_assets()

    def response(asset_id, method="get"):
        value = getattr(client, method)(reverse("linkding:assets.view", args=[asset_id]))
        return {
            "status": value.status_code,
            "headers": {name.lower(): text for name, text in value.items()},
            "base64": base64.b64encode(value.content).decode(),
        }
    result = {"assets": [response(asset.id) for asset in assets]}
    result["head"] = response(assets[0].id, "head")
    result["missing"] = response(assets[-1].id + 100)
    Path("/tmp/assets", assets[-1].file).unlink()
    result["missingFile"] = response(assets[-1].id)
    client.force_login(other)
    result["privateOther"] = response(assets[0].id)
    client.logout()
    result["privateGuest"] = response(assets[0].id)
    bookmark.shared = True
    bookmark.save()
    owner.profile.enable_sharing = True
    owner.profile.save()
    client.force_login(other)
    result["shared"] = response(assets[0].id)
    owner.profile.enable_public_sharing = True
    owner.profile.save()
    client.logout()
    result["public"] = response(assets[0].id)
    return result


def public_tests():
    from django.test.runner import DiscoverRunner

    class RecordedRunner(DiscoverRunner):
        def run_suite(self, suite, **kwargs):
            self.result = super().run_suite(suite, **kwargs)
            return self.result

    runner = RecordedRunner(verbosity=1, interactive=False)
    runner.run_tests([
        "bookmarks.tests.test_bookmark_asset_view",
        "bookmarks.tests.test_bookmark_assets",
        "bookmarks.tests.test_bookmark_assets_api",
    ])
    result = runner.result
    return {
        "testsRun": result.testsRun,
        "failures": len(result.failures), "errors": len(result.errors),
        "skipped": len(result.skipped), "expectedFailures": len(result.expectedFailures),
        "unexpectedSuccesses": len(result.unexpectedSuccesses),
        "details": [(str(test), detail) for test, detail in result.failures + result.errors],
    }


logs = io.StringIO()
try:
    with contextlib.redirect_stdout(logs), contextlib.redirect_stderr(logs):
        configure()
        if request["operation"] == "assets":
            output = observe_assets()
        elif request["operation"] == "public-tests":
            output = public_tests()
        elif request["operation"] == "browser":
            sys.path.insert(0, "/probes")
            from linkding_browser import observe_browser

            output = observe_browser(request, create_assets())
        else:
            raise ValueError("Unknown repository probe")
except Exception as error:
    output = {"error": type(error).__name__, "message": str(error)}
output["logs"] = logs.getvalue()
print(json.dumps(output))
