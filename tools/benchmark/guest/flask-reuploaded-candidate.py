import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import sys

sys.path.insert(0, "/work/src")

from flask_uploads import ALL
from flask_uploads import IMAGES
from flask_uploads import SCRIPTS
from flask_uploads import AllExcept
from flask_uploads import UploadConfiguration
from flask_uploads import UploadSet
from werkzeug.datastructures import FileStorage


def attempt(filename, *, extensions=ALL, folder=None, name=None, seed=(), symlink=False):
    with tempfile.TemporaryDirectory(prefix="sitecmd-upload-") as temporary:
        root = Path(temporary)
        destination = root / "root" / "uploads"
        outside = root / "outside"
        destination.mkdir(parents=True)
        outside.mkdir()
        for relative in seed:
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"existing")
        if symlink:
            (destination / "link").symlink_to(outside, target_is_directory=True)
        upload = UploadSet("files", extensions)
        upload._config = UploadConfiguration(str(destination))
        storage = FileStorage(stream=io.BytesIO(b"candidate payload"), filename=filename)
        result = None
        error = None
        message = None
        try:
            result = upload.save(storage, folder=folder, name=name)
        except Exception as exception:
            error = type(exception).__name__
            message = str(exception)
        inside = []
        escaped = []
        resolved_destination = destination.resolve()
        for file in root.rglob("*"):
            if not file.is_file() or file.is_symlink():
                continue
            resolved = file.resolve()
            if resolved.is_relative_to(resolved_destination):
                inside.append(resolved.relative_to(resolved_destination).as_posix())
            else:
                escaped.append(resolved.relative_to(root).as_posix())
        return {
            "result": result,
            "error": error,
            "message": message,
            "inside": sorted(inside),
            "outside": sorted(escaped),
        }


def name_boundary():
    with tempfile.TemporaryDirectory(prefix="sitecmd-name-") as temporary:
        absolute_name = str(Path(temporary) / "outside" / "absolute.txt")
        absolute = attempt("safe.txt", name=absolute_name)
    return {
        "traversalName": attempt("safe.txt", name="../../outside/traversal.txt"),
        "absoluteName": absolute,
        "traversalFolder": attempt("safe.txt", folder="../../outside", name="folder.txt"),
        "symlinkFolder": attempt("safe.txt", folder="link", name="symlink.txt", symlink=True),
        "disallowedExtension": attempt("photo.jpg", extensions=IMAGES, name="backdoor.py"),
        "emptyName": attempt("safe.txt", name="..."),
        "windowsSeparators": attempt("safe.txt", name="..\\temp\\evil.txt"),
        "ordinaryDefault": attempt("photo.JPG"),
        "ordinaryCustom": attempt("upload.txt", name="renamed.txt"),
        "explicitFolder": attempt("photo.jpg", folder="users"),
        "implicitFolder": attempt("photo.jpg", name="users/avatar.jpg"),
        "placeholder": attempt("photo.JPG", name="image."),
        "collision": attempt("photo.jpg", seed=("photo.jpg",)),
    }


def extension_casefold():
    blocked = AllExcept(SCRIPTS)
    return {
        "blockedPhp": attempt("safe.txt", extensions=blocked, name="backdoor.PHP"),
        "blockedMixedScript": attempt("safe.txt", extensions=blocked, name="backdoor.Js"),
        "allowedImage": attempt("photo.jpg", extensions=IMAGES, name="photo.JPG"),
        "defaultName": attempt("PHOTO.JPG", extensions=IMAGES),
        "lowerCustom": attempt("photo.jpg", extensions=IMAGES, name="photo.jpg"),
        "placeholder": attempt("photo.JPG", extensions=IMAGES, name="photo."),
        "collision": attempt(
            "photo.jpg", extensions=IMAGES, name="photo.jpg", seed=("photo.jpg",)
        ),
        "explicitFolder": attempt(
            "photo.jpg", extensions=IMAGES, folder="users", name="photo.jpg"
        ),
    }


def public_tests():
    environment = {
        **os.environ,
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": "/work/src",
        "PYTEST_ADDOPTS": "",
    }
    result = subprocess.run(
        [
            sys.executable,
            "-B",
            "-m",
            "pytest",
            "-q",
            "-p",
            "no:cacheprovider",
            "tests/test_flask_reuploaded.py",
        ],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
        env=environment,
    )
    log = result.stdout + result.stderr
    match = re.search(r"(\d+) passed", log)
    return {
        "exitCode": result.returncode,
        "tests": int(match.group(1)) if match else 0,
        "log": log,
    }


request = json.load(sys.stdin)
try:
    if request["operation"] == "flask-reuploaded-name-boundary":
        output = name_boundary()
    elif request["operation"] in {
        "flask-reuploaded-extension-casefold",
        "flask-reuploaded-default-name-control",
    }:
        output = extension_casefold()
    else:
        raise ValueError("Unknown Flask-Reuploaded probe")
    output["publicTests"] = public_tests()
except Exception as exception:
    output = {"error": type(exception).__name__, "message": str(exception)}
print(json.dumps(output))
